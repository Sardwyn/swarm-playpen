/**
 * Ground bot locomotion and the tick loop. Spec §3.1, §4.5.1, §9.
 *
 * Differential drive, nonholonomic, with a minimum turning radius. The
 * nonholonomic constraint is load-bearing: a robot that could strafe would not
 * need the rotation-to-face-goal dance below, and the turn-cost term in the
 * allocator (spec §6.3) would have no meaning.
 */

import type {
  AgentState,
  AgentSpec,
  Pose2,
  SimConfig,
  CalibrationState,
} from '../types.ts'
import type { Grid } from '../world/geometry.ts'
import {
  cellCenterX,
  cellCenterZ,
  markRayObservation,
  worldToCellX,
  worldToCellZ,
  inBounds,
  gridIndex,
} from '../world/geometry.ts'
import type { Rng } from '../rng.ts'
import { EventLog, agentCalibrated, agentFaulted, agentStranded, cellObserved } from '../eventlog.ts'
import { scanDepth, scanConfidence } from '../sensors/depth.ts'
import { NOISE, CAL } from '../sensors/noise.ts'
import { MISSION_DRIFT_HORIZON, IMU_CAL_DWELL, DT } from '../types.ts'
import { findPath, euclidean } from '../nav/astar.ts'
import type { JobRecord } from '../jobs/schema.ts'
import { regionCentre } from '../jobs/schema.ts'
import { TWO_PI, abs, clamp, cos, sin, sqrt, wrapPi, atan2, lerp, min } from '../math.ts'

/** Spec §3.1: ground bot, no arm, low-clearance chassis. */
export const GROUND_BOT: AgentSpec = {
  id: 'ground-01',
  cls: 'ground',
  manifold: 'ground',
  radius: 0.17,
  height: 0.11,
  minTurnRadius: 0.34,
  cruiseSpeed: 0.55,
  maxSpeed: 0.85,
  capabilities: [
    'ground.drive',
    'sense.depth',
    'sense.thermal',
    'sense.humidity',
    'sense.imu',
    'map.local',
    'map.merge',
    'recal.port',
  ],
  powerCruise: 22,
  powerSensors: 14,
  powerPeak: 48,
  batteryWh: 38,
  depthRange: 3.0,
}

/**
 * A second ground bot. Spec §3.1, and the precondition S8 has been missing.
 *
 * ## Why a second identical bot
 *
 * S8 asks whether the auction beats the obvious thing. That question needs two
 * agents that can bid for the *same* job, and until Stage E there was one. Stage E
 * added the inchworm and the count became two — and regret stayed identically zero,
 * because the two are on different manifolds and never compete. The hover bot will
 * not help either: it holds no `ground.drive` and sits on the volumetric manifold.
 *
 * So the only way to make the experiment runnable is a second ground agent, and that
 * is not a contrivance: S9's "all-ground" swarm is three of them. The homogeneous arm
 * of the thesis test needs this configuration to exist anyway.
 *
 * ## Why it is docked 10 m away
 *
 * Two bots at the same dock walk in formation and never contend for anything, so the
 * allocator would look evaluated while measuring nothing. The dock is in the kitchen,
 * **10.38 m** from `ground-01` in the hall — verified passable against the authored
 * grid, and asserted by a test, because a spawn inside a wall yields a run that looks
 * fine and measures nothing.
 *
 * ## What it is not
 *
 * It is not a control. Nothing in the suite depends on it existing, the reference
 * configuration is still one bot, and the parity pin does not involve it. It exists
 * so one scenario can be run.
 */
export const GROUND_BOT_2: AgentSpec = {
  ...GROUND_BOT,
  id: 'ground-02',
  spawn: { x: 5.0, z: -1.5, theta: 0 },
}

// ---------------------------------------------------------------------------
// Calibration. Spec §4.5.1
// ---------------------------------------------------------------------------

/**
 * Residual bias fraction at mission time `seconds`, per spec §4.5.1.
 *
 * 15% straight after calibration, growing linearly to 60% over
 * MISSION_DRIFT_HORIZON. The decay is the point: it makes mission length matter
 * and gives recalibration a cost, and without it calibration would be a
 * permanent fix and drift would stop being a phenomenon at all.
 */
export function residualBiasFraction(secondsSinceCalibration: number): number {
  const t = clamp(secondsSinceCalibration / MISSION_DRIFT_HORIZON, 0, 1)
  return lerp(CAL.calibratedResidual, CAL.driftedResidual, t)
}

/** Effective gyro bias magnitude in rad/s at a given calibration age. */
export function effectiveGyroBias(
  state: CalibrationState,
  secondsSinceCalibration: number,
  noiseMultiplier: number,
): number {
  const base = NOISE.gyroInitialBias * noiseMultiplier
  if (state === 'uncalibrated') return base
  return base * residualBiasFraction(secondsSinceCalibration)
}

export function calibrationStateFor(enabled: boolean): CalibrationState {
  return enabled ? 'calibrated' : 'uncalibrated'
}

/**
 * Run the dock excitation routine. Spec §4.5.1, §10 IMU_CAL_DWELL.
 *
 * Deliberately imperfect: it estimates bias down to 15%, it does not eliminate
 * it. A perfect calibration would delete drift — the input to loop closure,
 * fusion and every localisation metric in spec §9.3.
 */
export function calibrate(state: AgentState, rng: Rng): { state: AgentState; achievedBias: number } {
  // Imperfect on purpose (spec §4.5.1): 15% of initial bias, never zero. A
  // perfect calibration would delete drift, which is the input to loop closure
  // and every localisation metric in spec §9.3.
  const achieved =
    NOISE.gyroInitialBias * residualBiasFraction(0) * (0.85 + 0.3 * rng.next())
  return {
    state: {
      ...state,
      calibration: 'calibrated',
      ticksSinceCalibration: 0,
      calibrating: false,
    },
    achievedBias: achieved,
  }
}

/**
 * Waypoint arrival tolerance, metres. Used for BOTH the plan cursor advance and
 * `driveToward`'s arrival test.
 *
 * These must be the same number. If arrival is looser than the cursor advance,
 * the agent reaches a waypoint, reports arrival, and then cannot advance the
 * cursor past it — so it sits on a waypoint it has already reached and drives
 * nowhere, forever. The symptom is a run that looks alive (sensing, spending
 * power, logging events) while the coverage figure never moves, which is much
 * harder to notice than a crash.
 *
 * Must exceed one cell diagonal (~0.071 m) so a dense path is traversable.
 */
export const WAYPOINT_TOLERANCE = 0.12

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

export type LocomotionResult = {
  readonly state: AgentState
  readonly pathLength: number
  readonly arrived: boolean
  /** Ticks with no forward progress. Feeds the stranded check. */
  readonly stalledTicks: number
}

/**
 * Drive toward `goalX, goalZ` for one tick.
 *
 * The rotation-then-translate behaviour is what a differential-drive robot with
 * a minimum turning radius actually does. Skipping it would give a
 * strafe-capable robot, and every downstream cost estimate would be optimistic.
 */
export function driveToward(
  state: AgentState,
  grid: Grid,
  mask: Uint8Array,
  goalX: number,
  goalZ: number,
  dt: number,
): LocomotionResult {
  const spec = state.spec
  let pose = state.pose as Pose2
  const distToGoal = euclidean(pose.x, pose.z, goalX, goalZ)

  if (distToGoal < WAYPOINT_TOLERANCE) {
    return { state, pathLength: 0, arrived: true, stalledTicks: 0 }
  }

  // Bearing to goal, then the turn we must make.
  const desiredHeading = atan2(goalZ - pose.z, goalX - pose.x)
  const headingError = wrapPi(desiredHeading - pose.theta)

  // Rotation: proportional, rate-limited by the minimum turn radius at cruise
  // speed. omega = v / R, so a slower turn needs a slower crawl.
  const maxTurnRate = spec.cruiseSpeed / spec.minTurnRadius
  const maxTurn = maxTurnRate * dt
  const turn = clamp(headingError * 2.5, -maxTurn, maxTurn)

  let nextHeading = wrapPi(pose.theta + turn)
  let stepLength = 0
  let nextX = pose.x
  let nextZ = pose.z

  // Only translate once roughly aligned. A real robot that translates while
  // slewing traces an arc and drifts into walls; not modelling it is optimistic.
  if (abs(headingError) < 0.6) {
    const speedFactor = 1 - abs(headingError) / 0.6
    const speed = min(spec.maxSpeed, spec.cruiseSpeed * (0.35 + 0.65 * speedFactor))
    stepLength = speed * dt
    const nx = pose.x + cos(nextHeading) * stepLength
    const nz = pose.z + sin(nextHeading) * stepLength
    if (isPassable(grid, mask, nx, nz, pose.x, pose.z)) {
      nextX = nx
      nextZ = nz
    } else {
      // Blocked ahead. Try the heading we would have if we turned a little less,
      // which is what a real controller does rather than stopping dead.
      let escaped = false
      const swerve: ReadonlyArray<readonly [number, number]> = [
        [-0.12, 0],
        [0.12, 0],
        [-0.12, -0.12],
        [0.12, -0.12],
      ]
      for (const sw of swerve) {
        const ax = cos(nextHeading) + sw[0]
        const az = sin(nextHeading) + sw[1]
        const len = sqrt(ax * ax + az * az)
        const tx = pose.x + (ax / len) * stepLength
        const tz = pose.z + (az / len) * stepLength
        if (isPassable(grid, mask, tx, tz, pose.x, pose.z)) {
          nextX = tx
          nextZ = tz
          nextHeading = wrapPi(atan2(tz - pose.z, tx - pose.x))
          escaped = true
          break
        }
      }
      if (!escaped) {
        stepLength = 0
      }
    }
  }

  const moved = euclidean(nextX, nextZ, pose.x, pose.z)
  pose = { x: nextX, z: nextZ, theta: nextHeading }

  // A *flag*, not a count. The running total lives on the agent state, because a
  // local boolean cannot express "stuck for two seconds" and the first version
  // passed this straight into a 200-tick threshold that could therefore never be
  // reached. See §7.4 and `STALL_LIMIT_TICKS`.
  const stalledTicks = moved < 0.001 ? 1 : 0

  return {
    state: {
      ...state,
      pose,
      ticksSinceCalibration: state.ticksSinceCalibration + 1,
    },
    pathLength: moved,
    arrived: false,
    stalledTicks,
  }
}

/**
 * Ticks of no forward progress before an agent is declared stranded. Spec §7.4.
 *
 * Ten seconds at 10 Hz. Long enough that a robot squeezing past furniture or
 * turning in a tight room does not trip it, short enough that a wedged robot costs
 * 10 s of the mission rather than the rest of it.
 */
export const STALL_LIMIT_TICKS = 100

/**
 * Account for one tick of progress and report a stranding when the limit is crossed.
 *
 * Every exit from `tickAgent` must go through this, not just the one that drove. The
 * first version only accounted inside the drive path, so an agent that kept
 * *consuming* plans without moving — goal within tolerance of where it already
 * stands, plan exhausted, replan, repeat — never accumulated a single stalled tick
 * and was therefore invisible to the monitor it was supposed to be feeding. That is
 * the same freeze as a wedged wheel, wearing a different hat.
 */
function accountProgress(
  state: AgentState,
  movedThisTick: boolean,
  tick: number,
  log: EventLog,
): { stalledTicks: number; stranded: boolean } {
  const count = movedThisTick ? 0 : state.stalledTicks + 1
  return checkStuck(state, count, tick, log)
}

/**
 * Can an agent stand here?
 *
 * Tests the CENTRE cell against the passability mask, plus the segment midpoint
 * to stop a single tick tunnelling through a thin wall.
 *
 * It deliberately does NOT re-inflate by the agent radius. The mask already
 * encodes the footprint — `groundPassability` inflates obstacles by the bot's
 * half-width, so any cell the mask admits has the body clear of geometry by
 * construction. Inflating a second time here demands double the clearance, and
 * the planner and the controller then disagree about what is legal: A* returns a
 * path through a doorway that the controller then cannot drive, and the agent
 * wedges in the door with the coverage figure frozen.
 */
export function isPassable(grid: Grid, mask: Uint8Array, x: number, z: number, fromX?: number, fromZ?: number): boolean {
  if (!cellPassable(grid, mask, x, z)) return false
  if (fromX !== undefined && fromZ !== undefined) {
    if (!cellPassable(grid, mask, (x + fromX) / 2, (z + fromZ) / 2)) return false
  }
  return true
}

function cellPassable(grid: Grid, mask: Uint8Array, x: number, z: number): boolean {
  const cx = worldToCellX(grid, x)
  const cz = worldToCellZ(grid, z)
  if (!inBounds(grid, cx, cz)) return false
  return mask[gridIndex(grid, cx, cz)] === 1
}

// ---------------------------------------------------------------------------
// Energy. Spec §9.5
// ---------------------------------------------------------------------------

/**
 * Watts for this tick. Subsystem split matters: it is what makes the hover bot's
 * 86 W draw legible in a report rather than an aggregate.
 */
export function powerDraw(state: AgentState, moving: boolean): { locomotion: number; sensors: number; total: number } {
  const spec = state.spec
  const locomotion = moving ? spec.powerCruise : spec.powerCruise * 0.35
  const sensors = spec.powerSensors
  return { locomotion, sensors, total: locomotion + sensors }
}

// ---------------------------------------------------------------------------
// The tick. Spec §1.4 — fixed 10 Hz, no clock reads.
// ---------------------------------------------------------------------------

export type TickContext = {
  readonly config: SimConfig
  readonly grid: Grid
  readonly mask: Uint8Array
  readonly rng: Rng
  readonly log: EventLog
  readonly tick: number
  /** The job this agent currently holds, if any. Redirects its goal. */
  readonly job: JobRecord | undefined
}

export type FrontierResult = {
  readonly goal: { x: number; z: number }
  readonly pathLength: number
  readonly reached: boolean
  readonly exhausted: boolean
}

/**
 * Frontier-based exploration. Spec §5.6.
 *
 * Frontier = a passable cell adjacent to an unobserved cell. Candidates are
 * collected in ascending cell index order, so the chosen goal is a function of
 * the map alone — not of a heap's internal ordering. This matters for the
 * determinism test and costs nothing at this scale.
 */
export function pickFrontier(grid: Grid, mask: Uint8Array, fromX: number, fromZ: number): FrontierResult | null {
  let bestIndex = -1
  let bestScore = Number.POSITIVE_INFINITY

  for (let cz = 1; cz < grid.height - 1; cz++) {
    for (let cx = 1; cx < grid.width - 1; cx++) {
      const i = cz * grid.width + cx
      if (mask[i] !== 1) continue
      if (grid.observedCount[i]! > 0) continue

      // Only a frontier if it touches something observed. Otherwise it is an
      // unreachable pocket we would chase forever.
      let touchesKnown = false
      if (grid.observedCount[i - 1]! > 0 || grid.observedCount[i + 1]! > 0) touchesKnown = true
      if (grid.observedCount[i - grid.width]! > 0) touchesKnown = true
      if (grid.observedCount[i + grid.width]! > 0) touchesKnown = true
      if (!touchesKnown) continue

      const d = euclidean(cellCenterX(grid, cx), cellCenterZ(grid, cz), fromX, fromZ)
      // Reject frontiers the agent is already standing on. Such a goal is
      // "reached" the moment it is chosen, so the agent would never move, never
      // observe the cell, and would select the same zero-distance frontier
      // every tick. See `markFootprint` for the other half of this fix.
      if (d <= WAYPOINT_TOLERANCE) continue
      if (d < bestScore) {
        bestScore = d
        bestIndex = i
      }
    }
  }

  if (bestIndex < 0) return null

  const cx = bestIndex % grid.width
  const cz = (bestIndex - cx) / grid.width
  const gx = cellCenterX(grid, cx)
  const gz = cellCenterZ(grid, cz)

  const path = findPath(grid, mask, fromX, fromZ, gx, gz)
  return {
    goal: { x: gx, z: gz },
    pathLength: path.length,
    reached: path.reached,
    exhausted: false,
  }
}

// ---------------------------------------------------------------------------
// Job execution. Spec §6
// ---------------------------------------------------------------------------

/**
 * Where this agent should be heading this tick.
 *
 * A job, if it holds one; otherwise the frontier. The order matters: a robot
 * exploring while ignoring an awarded verification job is a robot that completes
 * no jobs and reports full coverage, which is exactly the failure that makes
 * coverage and job-completion metrics look fine while the swarm does nothing.
 */
export function goalFor(_state: AgentState, job: JobRecord | undefined): { x: number; z: number } | null {
  if (job !== undefined && job.job.state === 'active') {
    return regionCentre(job.job.region)
  }
  return null
}

/** Run one agent for one tick. Everything that mutates the agent lives here. */
export function tickAgent(ctx: TickContext, state: AgentState): AgentState {
  const { grid, mask, rng, log, tick, config } = ctx

  // --- calibration dwell ---------------------------------------------------
  if (state.calibrating) {
    const ticksLeft = state.ticksSinceCalibration - 1
    if (ticksLeft > 0) {
      return { ...state, ticksSinceCalibration: ticksLeft }
    }
    const result = calibrate(state, rng)
    // Logged so a report can say *how old* a map's calibration is rather than
    // implying a constant (spec §8.2 rule 3).
    log.push(
      agentCalibrated(tick, state.spec.id, {
        residualBias: result.achievedBias,
        dwellSeconds: IMU_CAL_DWELL,
      }),
    )
    return result.state
  }

  // --- perception ----------------------------------------------------------
  const pose = state.pose as Pose2
  const scan = scanDepth(
    grid,
    mask,
    state.spec.id,
    tick,
    pose.x,
    pose.z,
    pose.theta,
    state.spec.depthRange,
    rng,
    config.noiseMultiplier,
  )

  // --- decide --------------------------------------------------------------
  // Plan first, then follow it. Driving straight at a goal instead of following
  // an A* path is the classic Stage A bug: it looks fine in an open room and
  // walks into the first wall it meets.
  let plan = state.plan
  let planIndex = state.planIndex
  let goal = state.goal

  // A job goal overrides exploration. Replanning happens when the plan is spent
  // OR when the goal has moved, which is what stops a robot from finishing a
  // verification trip to a region it has left.
  const jobGoal = goalFor(state, ctx.job)
  const goalMoved =
    jobGoal !== null &&
    (goal === null || Math.abs(goal.x - jobGoal.x) > 0.5 || Math.abs(goal.z - jobGoal.z) > 0.5)
  const jobLost = jobGoal === null && state.currentJobId !== null

  const planExhausted = goal === null || planIndex >= plan.length || goalMoved || jobLost

  if (planExhausted) {
    if (jobGoal !== null) {
      const path = findPath(grid, mask, pose.x, pose.z, jobGoal.x, jobGoal.z)
      plan = path.points
      planIndex = 0
      goal = jobGoal
    } else {
      const frontier = pickFrontier(grid, mask, pose.x, pose.z)
      if (frontier === null) {
        // No frontier left and no job. This is the mission-complete state, not a
        // fault — so it does not accumulate stall. The agent standing still because
        // there is nothing left to do is doing the right thing.
        return {
          ...state,
          stalledTicks: 0,
          plan: [],
          planIndex: 0,
          goal: null,
          ticksSinceCalibration: state.ticksSinceCalibration + 1,
          calibrating: false,
          tickPathLength: 0,
        }
      }
      const path = findPath(grid, mask, pose.x, pose.z, frontier.goal.x, frontier.goal.z)
      plan = path.points
      planIndex = 0
      goal = frontier.goal
    }
  }

  // Advance the plan cursor past waypoints we have already reached.
  let cursor = planIndex
  while (cursor < plan.length) {
    const wp = plan[cursor]!
    if (euclidean(pose.x, pose.z, wp.x, wp.z) < WAYPOINT_TOLERANCE) {
      cursor++
    } else break
  }

  const nextWaypoint = plan[cursor]
  if (nextWaypoint === undefined) {
    // Plan consumed. Force a replan next tick.
    //
    // Accounted for progress even though nothing was driven, because consuming
    // plans without moving is still not moving. An agent whose goal sits inside its
    // own arrival tolerance will consume a plan every tick forever, and if only the
    // drive path feeds the stall counter it is invisible forever too.
    const spent = accountProgress(state, false, tick, log)
    return {
      ...state,
      stalledTicks: spent.stalledTicks,
      plan,
      planIndex: spent.stranded ? 0 : cursor,
      goal: spent.stranded ? null : goal,
      currentJobId: spent.stranded ? null : state.currentJobId,
      ticksSinceCalibration: state.ticksSinceCalibration + 1,
      tickPathLength: 0,
    }
  }

  const drive = driveToward(state, grid, mask, nextWaypoint.x, nextWaypoint.z, DT)

  // --- stranded detection and recovery, spec §7.4 --------------------------
  //
  // Recovery has to *change the situation*, not just re-derive the same plan.
  // Abandoning the plan and replanning from the same pose produces the same path
  // through the same gap, so the agent walks into it again for the rest of the
  // mission — which is what happened: one frontier region wedged the ground bot
  // at an identical pose for 2500 ticks, coverage froze at 63.83%, and nothing
  // said so because the monitor that would have said so was never called.
  //
  // So a stall costs the agent its current job. The job is released as failed
  // (spec §6.4 mechanism 3, failure handoff) rather than retried forever, and the
  // allocator is free to re-announce it excluding this agent. The agent then
  // resumes exploring, which is strictly better than standing in a pipe.
  const stuck = accountProgress(state, drive.pathLength >= 0.001, tick, log)

  let strandedThisTick = false
  if (stuck.stranded) {
    strandedThisTick = true
    plan = []
    planIndex = 0
    goal = null
    if (state.currentJobId !== null) {
      log.push({
        tick,
        kind: 'job.failed',
        jobId: state.currentJobId,
        agentId: state.spec.id,
        data: { reason: 1 },
      })
    }
  }

  // --- energy --------------------------------------------------------------
  const p = powerDraw(drive.state, drive.pathLength > 0.001)
  const whThisTick = (p.total * DT) / 3600

  const observedCells = countObserved(grid, mask)

  if (scan.points.length > 0 && tick % 10 === 0) {
    log.push({
      tick,
      kind: 'sensor.observation',
      agentId: state.spec.id,
      manifold: state.manifold,
      data: {
        pointCount: scan.points.length,
        confidence: scanConfidence(scan),
      },
    })
  }

  if (tick % 10 === 0) {
    log.push(
      cellObserved(tick, state.spec.id, state.manifold, {
        // From the scan itself, not from a module-level counter. A counter held
        // outside the run state would survive between runs and make "newly
        // observed" depend on what the previous run did — precisely the kind of
        // hidden state that makes a determinism test lie.
        newlyObserved: scan.newlyObserved,
        cumulative: observedCells,
      }),
    )
  }

  let battery = state.battery - whThisTick / state.spec.batteryWh
  let faulted = state.faulted

  // Spec §6.5 / §7.4: battery critical returns the agent to charge.
  if (battery < 0.15) {
    log.push({
      tick,
      kind: 'agent.battery_critical',
      agentId: state.spec.id,
      data: { battery },
    })
    battery = clamp(battery, 0, 1)
    if (battery <= 0) {
      if (!faulted) {
        log.push(agentFaulted(tick, state.spec.id, { reason: 1 }))
        faulted = true
      }
    }
  }

  return {
    ...drive.state,
    battery: clamp(battery, 0, 1),
    energyUsed: state.energyUsed + whThisTick,
    faulted,
    plan,
    planIndex: strandedThisTick ? 0 : cursor,
    goal: strandedThisTick ? null : goal,
    // The job is released, not merely abandoned: `currentJobId: null` is what lets
    // the allocator re-award it, and leaving it set would leave the job active with
    // nobody holding it, which is the conservation violation spec §6.5 forbids.
    currentJobId: strandedThisTick ? null : state.currentJobId,
    stalledTicks: stuck.stalledTicks,
    ticksSinceCalibration: state.ticksSinceCalibration + 1,
    tickPathLength: drive.pathLength,
  }
}

function countObserved(grid: Grid, mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1 && grid.observedCount[i]! > 0) n++
  }
  return n
}

/**
 * Stranded detection, spec §7.4.
 *
 * Returns the agent's new stall count and whether it has just crossed the limit.
 * The caller owns the decision about what to do about it, because only the caller
 * knows whether the agent is holding a job that must be released.
 *
 * **This function was dead until Stage E found it.** It was exported, correct in
 * shape, tested by nothing, and called from nowhere — and the `stalledTicks` it
 * took was a boolean rather than a count, so even a caller would have been handed
 * 1 where it expected 200. `stranded: 0` had been reported in every run since
 * Stage A, and it was not measuring anything: it was a counter nobody incremented.
 *
 * That is this project's signature failure in the one place it is most dangerous,
 * because the thing being missed is "a robot has stopped moving".
 */
export function checkStuck(
  state: AgentState,
  stalledTicks: number,
  tick: number,
  log: EventLog,
): { stalledTicks: number; stranded: boolean } {
  if (stalledTicks >= STALL_LIMIT_TICKS) {
    log.push(agentStranded(tick, state.spec.id, stalledTicks))
    return { stalledTicks: 0, stranded: true }
  }
  return { stalledTicks, stranded: false }
}

export { markRayObservation, findPath, TWO_PI }