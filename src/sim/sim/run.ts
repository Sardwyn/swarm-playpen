/**
 * The run loop. Spec §1.4 — fixed 10 Hz tick, injected time, no clock reads.
 *
 * Everything stateful lives in the returned `SimRun`. Nothing lives in module
 * scope, which is what makes two runs in the same process independent — a
 * module-level counter or cache would make run N depend on run N-1 and the
 * determinism test would pass while being meaningless.
 */

import type { AgentState, AgentSpec, SimConfig, Pose2, Pose3, Pose, JobId, Aabb } from '../types.ts'
import { HOVER } from '../types.ts'
import type { JobRecord } from '../jobs/schema.ts'
import { jobForCandidate, mapRegionJob, resetJobIds, inRegion, regionCentre, DWELL_TICKS } from '../jobs/schema.ts'
import { frontierRegions } from '../jobs/coverage.ts'
import { buildBid, rankBids, isStarved, eligibility } from '../jobs/market.ts'
import { TICK_HZ, DT, isLumenPose, isAirRegister } from '../types.ts'
import { Rng } from '../rng.ts'
import { EventLog } from '../eventlog.ts'
import type { Grid } from '../world/geometry.ts'
import {
  buildGroundGrid,
  groundPassability,
  coverage,
  uncoveredCells,
  CELL_OCCUPIED,
  CELL_BLOCKED,
  cellCenterX,
  cellCenterZ,
} from '../world/geometry.ts'
import type { House } from '../world/geometry.ts'
import type { AnomalySet } from '../world/anomalies.ts'
import { loadAnomalies01 } from '../world/anomalies.ts'
import { buildFields } from '../world/fields.ts'
import type { WorldFields } from '../world/fields.ts'
import { scanThermal } from '../sensors/thermal.ts'
import { scanDepth } from '../sensors/depth.ts'
import { DEPTH_RAYS } from '../world/geometry.ts'
import { sampleField } from '../world/fields.ts'
import { findPath3 } from '../nav/astar3.ts'
import { buildVolumetricGrid, volumetricPassability, VOXEL, type VoxelGrid } from '../world/volumetric.ts'
import { stepHover, hoverPower, whForTick } from './hover.ts'
import { createCeilingRaster, observeCeiling, type CeilingRaster } from './ceiling.ts'
import { detectBlockedVent } from './detectors.ts'
import { TWO_PI, sqrt, clamp } from '../math.ts'
import { createScalarState, readHumidity, readAir } from '../sensors/scalar.ts'
import type { ScalarSensorState } from '../sensors/scalar.ts'
import type { Candidate, DetectorState } from './detectors.ts'
import {
  createDetectorState,
  detectThermalBaseline,
  detectThermalAbsolute,
  detectHumidityBaseline,
  detectClutter,
  detectCrackProxy,
  detectPestProxy,
  rememberThermal,
} from './detectors.ts'
import { GROUND_BOT, tickAgent } from './agents.ts'
import { buildLumenGraph, positionAt, canEnter, isIrreversible, routeInLumen } from '../world/lumen.ts'
import type { LumenGraph } from '../world/lumen.ts'
import { tickInchworm, createInchwormState, isAtTarget, graphPosOf } from './inchworm.ts'
import type { InchwormState, LumenTarget } from './inchworm.ts'
import { conduitScanJob, BID_WINDOW } from '../jobs/schema.ts'
import { buildConduitObstructions } from '../world/bore.ts'
import type { BoreObstruction } from '../world/bore.ts'
import { detectBoreObstruction, handoffPortFor, createConstrainedDetectorState } from './constrained.ts'
import type { ConstrainedDetectorState } from './constrained.ts'
import { CONFIDENCE_MIN } from '../report/report.ts'

export type SimRun = {
  readonly config: SimConfig
  readonly house: House
  readonly grid: Grid
  readonly mask: Uint8Array
  readonly rng: Rng
  readonly log: EventLog
  /** Ground truth. Read by fields and by the metrics; never by a detector. */
  readonly truth: AnomalySet
  readonly fields: WorldFields
  agents: AgentState[]
  /** All candidates raised this run, in order. The report's input. */
  candidates: Candidate[]
  /** Per-agent sensor memory. First-order lag state, per spec §4.3. */
  sensors: Map<string, ScalarSensorState>
  /** Per-agent detector baselines. */
  detectors: Map<string, DetectorState>
  /**
   * The constrained manifold. Spec §2.2, Stage E.
   *
   * Built from authored content. A house with no conduits yields an empty graph,
   * which is a valid state: every `scan_pipe` job then fails to route and starves,
   * and the run says so rather than pretending the manifold was covered.
   */
  lumen: LumenGraph
  /**
   * The volumetric manifold. Spec §5.4, Stage F.
   *
   * `volMask` is dilated by the hover bot's rotor radius and `vol` is not, because the two
   * are used for different things: the planner and the controller need the body clear, while
   * the depth sensor measures to the surface and would report everything 0.20 m early if it
   * saw the dilated version. Conflating them is the same over-reservation the 2-D planner
   * deliberately avoids.
   */
  readonly vol: VoxelGrid
  readonly volMask: Uint8Array
  /**
   * Ceiling rasters, one per volumetric agent. The stage F gate's evidence.
   *
   * Keyed by agent id and absent for non-volumetric agents, mirroring `inchworms`. Held on
   * the run rather than recomputed for the report, because a metric derived from a summary
   * cannot be audited — the whole point of the gate is that the raster is inspectable.
   */
  hoverRasters: Map<string, CeilingRaster>
  /**
   * Per-crawler lumen state. Keyed by agent id, absent for non-crawlers.
   *
   * Held here rather than in module scope so two runs in the same process cannot
   * contaminate each other (ADR-001 §2.4) — a crawler that remembered its last
   * feature node across runs would make the loop-closure metric a function of test
   * order.
   */
  inchworms: Map<string, InchwormState>
  /**
   * Arc positions already traversed, per conduit. The constrained manifold's
   * analogue of the grid's `observedCount`, and the only thing `conduitScanJob`
   * announcements are derived from. It is a record of the swarm's own history, not
   * of the oracle.
   */
  conduitCoverage: Map<string, number[]>
  /**
   * Obstructions inside each conduit, built from the oracle at run construction.
   *
   * World-building, exactly as `fields` is: the oracle defines the world, the
   * crawler's range finder reads geometry, and the detector reads the range. A
   * detector reading the oracle directly would be the leak; that line is held by
   * `test/boundary/no-ground-truth-leak.test.ts`.
   */
  conduitObstructions: Map<string, BoreObstruction[]>
  /**
   * Constrained-manifold detector state, keyed by agent id.
   *
   * Its own map rather than folded into `detectors`, because these detectors answer
   * a different question — "is the bore clear" — from an instrument that is not the
   * ground bot's depth fan.
   */
  constrainedDetectors: Map<string, ConstrainedDetectorState>
  /**
   * Handoff tally. Spec §6.4 mechanism 1.
   *
   * `confirmed` counts escalations where a thermal-capable agent found corroborating
   * evidence at the port. The rate is a real measurement and it is expected to be
   * poor: nothing standing in a room can see inside a sealed pipe.
   */
  handoffs: { raised: number; confirmed: number; unconfirmed: number }
  /**
   * Where each crawler is, in the form the lumen router takes. Published each tick
   * because a crawler's position is graph state rather than a pose field, and the
   * auction needs to route from it.
   */
  lumenPositions: Map<string, LumenTarget | { atPort: string }>
  /**
   * Separate state for the naive control detector.
   *
   * Its own state rather than a throwaway, because its persistence filter has to
   * survive across ticks — resetting it each tick turns a detector into a spew
   * of one candidate per ray per tick.
   */
  controlDetector: DetectorState
  /**
   * Live job market. Spec §6.
   *
   * Jobs are spawned from what the swarm has *found*, never from the oracle — see
   * `jobs/schema.ts`. A coordinator that reads the answer key produces a swarm
   * that has been told where the defects are, and every accuracy number computed
   * over it would still print.
   */
  jobs: Map<JobId, JobRecord>
  /** Per-agent current load in job-seconds, for the auction's load term. */
  load: Map<string, number>
  /**
   * Per-award regret inputs: the winner's actual path length against the shortest
   * any bidder could have managed. Spec §9.4 — the number S8 uses to decide
   * whether the auction survives at all.
   */
  regretSamples: Array<{ winnerDistance: number; bestDistance: number }>
  /**
   * Awards where **two or more** agents were eligible bidders. Spec §9.4.
   *
   * This is what makes regret evaluable, and it is the honest test. Counting agents
   * is not: Stage E has two agents and regret is *still* identically zero, because
   * the ground bot cannot bid on a conduit job and the inchworm cannot bid on a
   * region job. They are on different manifolds, so they never compete for
   * anything, and a mean regret of 0.00% over 37 awards is measuring the absence of
   * competition rather than the quality of the auction.
   *
   * The kill decision reads `contested > 0` and nothing else. A verdict printed
   * from an unevaluable mean is worse than no verdict, because it looks like a
   * measurement.
   */
  contestedAwards: number
  /** Job lifecycle tally, for the conservation invariant. */
  jobTally: Record<string, number>
  /**
   * Regions an agent is excluded from bidding on, with the tick the exclusion
   * lapses. Spec §6.4 mechanism 3, failure handoff.
   *
   * Keyed by agent, then by region. The region scoping is not a refinement — a
   * *global* ban is what the first version did, and with one agent it meant a
   * single stranding benched the only robot for 30 seconds: jobs completed fell
   * from 31 to 17 and starved rose from 9 to 18, all of it the cooldown's doing
   * rather than the stall's. The exclusion is knowledge about a *place* ("this
   * robot cannot get through there"), so it has to be scoped to that place. In a
   * swarm a global ban is merely wasteful; with a single agent it is paralysis.
   */
  bidExclusions: Map<string, Map<string, number>>
  tick: number
  done: boolean
}

/**
 * Detector thresholds. In one place because they are the tuning surface a
 * scenario sweeps, and thresholds scattered through call sites are thresholds
 * nobody sweeps.
 */
export const MARKET = {
  /** Coverage jobs announced per free agent, per tick. */
  coverageJobsPerFreeAgent: 1,
  /** Suppression radius for spawning a job per finding, metres. */
  spawnRadius: 1.0,
} as const

/**
 * Arc-length bucket size for the crawler's coverage profile, metres.
 *
 * Matches `CELL`. Not a free choice: a coarser profile over-reports coverage
 * between two closely spaced traversals, and the report would claim a stretch was
 * surveyed that no agent was ever at.
 */
export const CONDUIT_ARC_RESOLUTION = 0.05

/**
 * Shortest unsurveyed stretch worth announcing a job for, metres.
 *
 * Below this the crawler pays a full entry and exit to inspect a token length of
 * bore. Chosen as a rough multiple of the 0.12 m arrival tolerance, so a job's
 * target is worth more than the slack the arrival test already gives away.
 */
export const MIN_SURVEY_RUN = 0.75

/**
 * Ticks an agent is excluded from a region after being stranded there. Spec §6.4
 * mechanism 3.
 *
 * Thirty seconds. Long enough that the region has stopped being re-announced while
 * the agent is still close enough to be tempted by it, and long enough that the
 * exclusion costs less than the job did. Short enough that a genuinely transient
 * wedge — furniture shifted, a door swung — does not disqualify a robot for the rest
 * of the mission.
 */
export const BID_COOLDOWN_TICKS = 300

/** Region bucket size for exclusions, metres. Coarse on purpose. */
const EXCLUSION_CELL = 2

/**
 * Region key for an exclusion.
 *
 * Coarse, because the exclusion is about a *place* and neighbouring frontier
 * regions share the same gap. Keying on exact region bounds would let the bot be
 * handed a job 10 cm from the one it just failed, which is the loop this exists to
 * break.
 */
function exclusionKey(region: Aabb): string {
  const cx = (region.minX + region.maxX) / 2
  const cz = (region.minZ + region.maxZ) / 2
  return `${Math.round(cx / EXCLUSION_CELL)}:${Math.round(cz / EXCLUSION_CELL)}`
}

/** Is this agent barred from this region right now? */
function isExcluded(run: SimRun, agentId: string, region: Aabb): boolean {
  const forAgent = run.bidExclusions.get(agentId)
  if (forAgent === undefined) return false
  const until = forAgent.get(exclusionKey(region))
  return until !== undefined && run.tick < until
}

/**
 * Would excluding every barred agent leave this job with no possible bidder?
 *
 * If so, the exclusion is not applied. Spec §6.4 mechanism 3 exists to stop two
 * agents thrashing on a job neither can finish, and it presumes there is another
 * agent to hand the work to.
 *
 * With one agent there is not, and applying it anyway means a single stranding
 * benched the only robot for half a minute: jobs completed fell 31 → 17 and
 * starvation rose 9 → 47. Every one of those extra failures was the *exclusion's*
 * doing rather than the stall's — the recovery mechanism cost more than the fault
 * it was recovering from.
 *
 * So the exclusion is a preference, never a guarantee: it may only withhold an
 * agent from a job someone else could actually take.
 */
function exclusionWouldStarve(run: SimRun, record: JobRecord): boolean {
  let eligibleNow = 0
  for (const agent of run.agents) {
    if (agent.currentJobId === null && eligibility(agent, record).ok) eligibleNow++
  }
  let barred = 0
  for (const agent of run.agents) {
    if (agent.currentJobId === null && eligibility(agent, record).ok && isExcluded(run, agent.spec.id, record.job.region)) {
      barred++
    }
  }
  return eligibleNow - barred <= 0
}

/** Bar an agent from a region for the cooldown window. */
function excludeFrom(run: SimRun, agentId: string, region: Aabb): void {
  const forAgent = run.bidExclusions.get(agentId) ?? new Map<string, number>()
  forAgent.set(exclusionKey(region), run.tick + BID_COOLDOWN_TICKS)
  run.bidExclusions.set(agentId, forAgent)
}
export const DETECTOR_THRESHOLDS = {
  /** K above the agent's own estimated baseline. Spec §4.2. */
  thermalBaselineK: 2.5,
  /**
   * The design temperature the naive control assumes, in Kelvin (20 C). Not
   * measured — that is the defect being measured. Two-sided, because a one-sided
   * absolute threshold cannot express "too cold" at all and scored perfect
   * precision by finding only hot defects.
   */
  thermalDesignK: 293.15,
  /** K either side of the design temperature that the control calls interesting. */
  thermalDesignRiseK: 3.0,
  /** Candidate association radius. 1.0 m merges approach duplicates without merging neighbours. */
  associationRadius: 1.0,
  /** RH above the agent's own mean. Spec §4.3. */
  humidityRh: 0.06,
  /** Crack proxy score. */
  crackProxy: 2.4,
  /** Radius within which a blocked cell counts as adjacent to a thermal finding. */
  pestRadius: 0.8,
  /** How close the agent must be to a port before its air reading counts. */
  ventRange: 2.5,
  /**
   * A port's air reading this far *above ambient* means poor extraction.
   * A ratio, not an absolute number: the air field runs roughly 0.15-0.65 and an
   * absolute threshold sits outside that range and silently never fires.
   */
  ventRelativeRise: 1.5,
  /** Minimum cluster size for a thermal candidate. One ray is noise. */
  thermalMinRays: 2,
} as const

export function defaultConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    seed: 1,
    tickHz: TICK_HZ,
    noiseMultiplier: 0,
    missionSeconds: 1000,
    groundCellSize: 0.05,
    enableCalibration: true,
    enableJobs: true,
    initialBatteryFraction: 1,
    agents: [GROUND_BOT],
    /**
     * Port the inchworm starts and idles at. Spec §3.2.
     *
     * It is a config value rather than a constant because it decides *which part of
     * the constrained manifold the swarm can work at all* — see `lumenComponents`.
     * The constrained manifold is not connected, so this single field selects one
     * component and makes the rest unreachable. That is a fact about the house, and
     * a scenario needs to be able to choose which fact it is studying.
     */
    inchwormHomePort: 'duct-drop-utility',
    ...overrides,
  }
}

export function createRun(
  house: House,
  config: SimConfig,
  spawn: { x: number; z: number; theta: number },
): SimRun {
  const grid = buildGroundGrid(house)
  const mask = groundPassability(grid)
  const rng = new Rng(config.seed)
  const log = new EventLog()

  const agents: AgentState[] = config.agents.map((spec) => ({
    stalledTicks: 0,
    spec,
    // A crawler has no metric pose to hold at the dock: it is standing at a port.
    // Seeding it with the ground spawn would put it in the volumetric manifold's
    // coordinate frame, and every `isLumenPose` check downstream would then take the
    // wrong branch and try to A* through a bore.
    //
    // The hover bot needs a third case for the same class of reason: it is seeded with a
    // `Pose3` at `spawn.y`, defaulting to eye height, because a `Pose2` has no height and
    // every volumetric consumer - the clearance model, the raycast, the raster - would read
    // `undefined` as 0 and put the bot inside the floor. Defaulting to 1.2 m rather than 0
    // is deliberate: it is a height where the clearance model has something to say.
    pose: seedPose(spec, spawn),
    manifold: spec.manifold,
    battery: clamp(config.initialBatteryFraction, 0, 1),
    energyUsed: 0,
    // Spec §4.5.1: agents start at dock, so calibration runs before the first
    // mission tick. Stage A runs with calibration on; S4 variant 4b turns it off.
    calibration: config.enableCalibration ? 'calibrated' : 'uncalibrated',
    ticksSinceCalibration: 0,
    calibrating: false,
    faulted: false,
    plan: [],
    planIndex: 0,
    // Volumetric-only state. Empty for every ground and constrained agent, and the
    // hover bot's pose above is seeded the same way, so an agent that never leaves its
    // manifold carries a zero-length 3-D plan rather than a stale one.
    plan3: [],
    plan3Index: 0,
    tilt: 0,
    goal: null,
    currentJobId: null,
    tickPathLength: 0,
  }))

  log.push({
    tick: 0,
    kind: 'run.started',
    data: {
      seed: config.seed,
      noiseMultiplier: config.noiseMultiplier,
      missionSeconds: config.missionSeconds,
      agentCount: config.agents.length,
    },
  })

  const truth = loadAnomalies01()
  const fields = buildFields(house.bounds, truth)

  const sensors = new Map<string, ScalarSensorState>()
  const detectors = new Map<string, DetectorState>()
  const load = new Map<string, number>()
  const vol = buildVolumetricGrid(house)
  // 0.12 m rotor span over 0.10 m voxels = 2 cells. Derived from the spec rather than
  // inlined so the planner and the coverage metric cannot disagree about the body size.
  const volMask = volumetricPassability(vol, Math.ceil(HOVER.radius / VOXEL))
  const hoverRasters = new Map<string, CeilingRaster>()
  const inchworms = new Map<string, InchwormState>()
  for (const spec of config.agents) {
    sensors.set(spec.id, createScalarState())
    detectors.set(spec.id, createDetectorState())
    load.set(spec.id, 0)
    if (spec.cls === 'inchworm') inchworms.set(spec.id, createInchwormState())
    // One raster per volumetric agent, over the whole house footprint. Created here rather
    // than lazily so that an agent which never flies still has an inspectable empty raster
    // scoring 0 - a lazily-created raster would be indistinguishable from an agent that
    // was never supposed to raster.
    if (spec.manifold === 'volumetric') {
      hoverRasters.set(
        spec.id,
        createCeilingRaster(
          house.bounds.minX + 0.5,
          house.bounds.minZ + 0.5,
          house.bounds.maxX - house.bounds.minX - 1.0,
          house.bounds.maxZ - house.bounds.minZ - 1.0,
          0.25,
        ),
      )
    }
  }

  const lumen = buildLumenGraph(house.conduits)
  const conduitCoverage = new Map<string, number[]>()
  // Bucketed at the same 5 cm resolution as the ground grid, so the two manifolds'
  // coverage figures mean the same thing and a scenario can print them side by
  // side. `new Array(geo.total + 1)` is the tempting one-liner and it throws
  // RangeError, because arc length is a float.
  for (const [id, geo] of lumen.conduits) {
    conduitCoverage.set(id, new Array<number>(Math.ceil(geo.total / CONDUIT_ARC_RESOLUTION) + 1).fill(0))
  }

  // Job ids must not survive between runs (spec §1.4).
  resetJobIds()

  return {
    config,
    house,
    grid,
    mask,
    rng,
    log,
    truth,
    fields,
    agents,
    candidates: [],
    sensors,
    detectors,
    lumen,
    vol,
    volMask,
    hoverRasters,
    inchworms,
    conduitCoverage,
    lumenPositions: new Map(),
    conduitObstructions: buildConduitObstructions(truth),
    constrainedDetectors: new Map(
      config.agents
        .filter((spec) => spec.cls === 'inchworm')
        .map((spec) => [spec.id, createConstrainedDetectorState()] as const),
    ),
    handoffs: { raised: 0, confirmed: 0, unconfirmed: 0 },
    controlDetector: createDetectorState(),
    jobs: new Map<JobId, JobRecord>(),
    load,
    regretSamples: [],
    contestedAwards: 0,
    jobTally: { announced: 0, awarded: 0, active: 0, blocked: 0, done: 0, failed: 0 },
    bidExclusions: new Map(),
    tick: 0,
    done: false,
  }
}

/**
 * Advance one tick. Returns true when the run has finished.
 *
 * Agents are stepped in ascending id order. Spec §1.4 forbids order-dependent
 * results, and ordering by a stable id rather than by array position is what
 * makes that hold when `config.agents` is built in a different order.
 */
export function step(run: SimRun): boolean {
  if (run.done) return true

  const ordered = [...run.agents].sort((a, b) => (a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0))

  for (const agent of ordered) {
    const index = run.agents.indexOf(agent)
    if (index < 0) continue

    // Dispatch on class. A crawler stepped through `tickAgent` would be handed the
    // ground grid and given a goal in (x, z), and the first thing that would
    // happen is an A* call with a conduit pose — which returns an empty path, and
    // the agent then stands still for the whole mission while the report shows a
    // crawler that is neither moving nor faulted.
    if (agent.spec.cls === 'inchworm') {
      run.agents[index] = stepInchwormAgent(run, index)
    } else if (agent.spec.manifold === 'volumetric') {
      // Third branch, same reason as the first: a volumetric agent handed to `tickAgent`
      // would be given the 2-D ground grid and a goal in (x, z), and the planner would
      // return an empty path because there is no `z` to plan in. The bot would then hover
      // in place for the whole mission while the report showed a hover bot that was neither
      // moving nor faulted — which is the exact failure the inchworm branch's comment
      // describes, one manifold over.
      run.agents[index] = stepHoverAgent(run, index)
    } else {
      run.agents[index] = tickAgent(
        {
          config: run.config,
          grid: run.grid,
          mask: run.mask,
          rng: run.rng,
          log: run.log,
          tick: run.tick,
          job: agent.currentJobId === null ? undefined : run.jobs.get(agent.currentJobId),
        },
        agent,
      )
    }
  }

  run.candidates.push(...detectThisTick(run))

  if (run.config.enableJobs) stepMarket(run)

  run.tick++

  const maxTicks = run.config.missionSeconds * TICK_HZ
  if (run.tick >= maxTicks) {
    run.done = true
    closeOutJobs(run)
    run.log.push({
      tick: run.tick,
      kind: 'run.finished',
      data: { tick: run.tick, truncated: run.log.isTruncated ? 1 : 0 },
    })
    return true
  }
  return false
}

/**
 * Close every job still in flight when the mission ends.
 *
 * A crawler part-way down a 28 m conduit at tick 3000 is genuinely unfinished, and
 * leaving its job in `active` means the lifecycle invariant is violated by the run
 * rather than by the swarm: `announced ≠ done + failed`, and nobody ever decided to
 * drop the work. It vanishes without a decision, which is the failure mode spec
 * §6.5 exists to prevent.
 *
 * So unfinished work is marked `failed` — the honest state, since the job's output
 * contract was not met — and the tally follows. Announced work that the swarm
 * could not finish in the time given is *not* the same as work that was never
 * announced, and the tally is where that distinction is visible.
 *
 * Deliberately not a log event. The log is evidence about the simulation's
 * decisions; the mission ending is already one event, and a second one per stranded
 * job would make the end-of-run tail of the log a function of the mission length.
 */
function closeOutJobs(run: SimRun): void {
  for (const record of run.jobs.values()) {
    const wasActive = record.job.state === 'active'
    if (!wasActive && record.job.state !== 'announced') continue
    record.job.state = 'failed'
    record.job.escalations += 1
    run.jobTally.failed = (run.jobTally.failed ?? 0) + 1
    if (wasActive) {
      run.jobTally.active = Math.max(0, (run.jobTally.active ?? 1) - 1)
    }
    const holder = run.agents.find((a) => a.currentJobId === record.job.id)
    if (holder !== undefined) holder.currentJobId = null
  }
}

/** Run to completion. This is what a scenario calls. */
export function runToCompletion(run: SimRun): SimRun {
  let guard = run.config.missionSeconds * TICK_HZ + 16
  while (!step(run) && guard-- > 0) {
    // Intentionally empty — step() owns the loop's exit condition.
  }
  return run
}

/**
 * One tick of a crawling agent, plus its bookkeeping on the constrained manifold.
 *
 * Split out from `step` because the crawler needs two things the ground path has
 * no concept of: it must record where it has actually been (so survey jobs can be
 * spawned from its own history), and it must be prevented from exiting a conduit
 * it cannot leave.
 */
/**
 * Step the hover bot one tick: plan in 3-D, fly, raster the ceiling, pay for it.
 *
 * ## What it does when it has no job
 *
 * It holds a survey station and records ceiling observations. That is not idling: the stage
 * F gate asks for *raster confidence*, and confidence comes from repeated observation, so a
 * hover bot with nothing to do is doing the gate's work. It is also the state the endurance
 * finding lives in � �11.30 measured that the binding constraint is altitude, and holding
 * station high is how a run would hit it.
 *
 * ## Where the ceiling raster is pointed
 *
 * One observation per tick, at the bot's own (x, z), recording the deviation it reads there
 * and the altitude it read it from. Two properties are deliberate:
 *
 * - The **altitude is recorded**, because that is the only genuinely volumetric part of the
 *   reading (�11.31). The scalar field it samples is a ground-plane projection that ignores
 *   `y`, so the thermal value carries no height information � and `summariseRaster` says so
 *   in its output rather than in a comment.
 * - **One cell per tick, not a fan of rays.** A fan would multiply the cell count per tick
 *   and make confidence reach the gate in a fraction of the time, which would make the gate
 *   a statement about tick rate rather than about flying somewhere.
 */
function stepHoverAgent(run: SimRun, index: number): AgentState {
  const state = run.agents[index]!
  const pose = state.pose as Pose3
  const spec = state.spec

  let next = state

  // --- plan, if there is somewhere to go ------------------------------------------
  // The goal comes from the job the market awarded, as a 3-D point. Until volumetric jobs
  // are announced (Stage F's remaining work) there is none, and the bot surveys in place �
  // which is recorded here rather than left implicit, because "no volumetric jobs exist yet"
  // and "the bot reached its goal" are different states.
  if (state.currentJobId !== null) {
    const record = run.jobs.get(state.currentJobId)
    const goal = record?.job.region
    if (goal) {
      const cx = (goal.minX + goal.maxX) / 2
      const cz = (goal.minZ + goal.maxZ) / 2
      // Survey altitude: high enough to be under a ceiling, low enough not to be in the
      // penalty band �11.30 measured as fatal. 1.8 m in a 2.50 m room leaves 0.70 m above,
      // which is a 1.4x endurance margin.
      const plan = findPath3(run.vol, run.volMask, pose.x, pose.y, pose.z, cx, 1.8, cz)
      next = { ...next, plan3: plan.points, plan3Index: 0 }
    }
  }

  const stepped = stepHover(run.vol, run.volMask, next, DT)
  next = stepped.state

  // --- energy ---------------------------------------------------------------------
  // The full three-term model, including the clearance penalty, so the endurance finding
  // is reachable in a run rather than only in a unit test: a bot holding station at 2.2 m
  // runs its pack dry before 300 s, and this is where that happens.
  const power = hoverPower(run.vol, next.pose as Pose3, next.tilt, stepped.moved)
  const wh = whForTick(power.total, DT)
  next = {
    ...next,
    energyUsed: next.energyUsed + wh,
    battery: clamp(next.battery - (wh / spec.batteryWh), 0, 1),
  }

  // --- raster the ceiling ----------------------------------------------------------
  const raster = run.hoverRasters.get(spec.id)
  if (raster) {
    const now = next.pose as Pose3
    const baseline = run.fields.temperature.baselineAt(now.x, now.z)
    observeCeiling(raster, now.x, now.z, now.y, sampleField(run.fields.temperature, now.x, now.z) - baseline)
  }

  // --- stall accounting, shared with the other agents ------------------------------
  // A hover bot with an exhausted plan is not stuck, it has arrived � so only a *refused*
  // step counts as a stall. `stepHover` returns moved: false for both, and conflating them
  // would strand a bot that is deliberately holding station.
  if (next.battery <= 0) {
    next = { ...next, faulted: true, currentJobId: null, plan3: [], plan3Index: 0 }
    run.log.push({
      tick: run.tick,
      kind: 'agent.faulted',
      agentId: spec.id,
      // `reason` is numeric on this event. 1 means battery exhausted.
      //
      // Filed as `agent.faulted` rather than `agent.stranded` because stranded specifically
      // means *stuck in geometry* - `ticksStuck` counts ticks without progress. A hover bot
      // that flew until its pack died made plenty of progress and is stranded by nothing, so
      // filing it under `stranded` would corrupt the one metric that diagnoses navigation
      // failures. And this is exactly the state 11.30's altitude sweep predicts: a bot
      // holding station above about 2.1 m runs its 22 Wh pack dry inside a 300 s mission.
      data: { reason: 1 },
    })
  }

  // load accumulates seconds of work, not watts - the ground bot adds DT the same way
  // (run.ts:1470). Adding watts here would have made the coordinator's load map
  // meaningless for every agent except this one.
  run.load.set(spec.id, (run.load.get(spec.id) ?? 0) + DT)
  next.tickPathLength = stepped.pathLength
  return next
}

function stepInchwormAgent(run: SimRun, index: number): AgentState {
  const agent = run.agents[index]!
  const inch = run.inchworms.get(agent.spec.id)
  if (inch === undefined) return agent

  const job = agent.currentJobId === null ? undefined : run.jobs.get(agent.currentJobId)
  const target: LumenTarget | null = job?.job.conduit ?? null

  // Sensor run first: the bore scan is what both records coverage and raises
  // suspicions, and it has to reflect where the agent was before this tick's
  // motion, not after.
  senseInConduit(run, agent, inch)

  const result = tickInchworm(agent, inch, {
    graph: run.lumen,
    rng: run.rng,
    log: run.log,
    tick: run.tick,
    noiseMultiplier: run.config.noiseMultiplier,
    job: target,
    homePort: run.config.inchwormHomePort,
  })

  run.agents[index] = result.state

  // Position is not a field the market can read: it is graph state. Publish it so
  // `collectBids` can route from where the crawler actually is.
  run.lumenPositions.set(result.state.spec.id, graphPosOf(inch, run.config.inchwormHomePort))

  return result.state
}

/**
 * Crawler positions, published for the auction.
 *
 * On the run, never in module scope. A map that survived between runs would let a
 * run's bid depend on the previous run's crawl — the determinism hole ADR-001 §2.4
 * exists to close, and it would be reintroduced here by accident.
 */
export function currentLumenPositions(run: SimRun): ReadonlyMap<string, LumenTarget | { atPort: string }> {
  return run.lumenPositions
}

/**
 * Depth sensing down the bore, and the coverage record it feeds.
 *
 * ## Why the crawler cannot use the ground grid
 *
 * Inside a 40 mm pipe there is no floor. A* over the ground occupancy grid has
 * nothing to say about this space, and pretending otherwise is how a simulator ends
 * up claiming the crawl was "mapped". So the crawler's map is a 1-D coverage
 * profile over arc length, and it is recorded by **traversal**, not by ray casting
 * — the agent has physically been there. A ray cast would mark a stretch as seen
 * the instant the bot could see it down the pipe, which is a different and much
 * weaker claim.
 *
 * ## The detector question this raises
 *
 * ## The detector this replaced
 *
 * The first version of this function read humidity — a scalar the crawler does not
 * have. Spec §3.2's capability list is `crawl.small`, `crawl.medium`, `sense.depth`,
 * `sense.imu`, `map.graph`, `map.merge`, and `sense.humidity` is not on it. Granting
 * it was the wrong repair for the right observation: it would have given the crawler
 * a way to raise findings it could partly corroborate, and the handoff that the
 * missing capability *forces* would never have been exercised.
 *
 * The only instrument it has is `sense.depth`, so the only finding it can raise is
 * geometric: something is in the way. That is what this function scans for.
 */
function senseInConduit(run: SimRun, agent: AgentState, inch: InchwormState): void {
  if (inch.pose === null) return
  const covered = run.conduitCoverage.get(inch.pose.conduitId)
  if (covered === undefined) return

  const index = Math.round(inch.pose.arc / CONDUIT_ARC_RESOLUTION)
  if (index >= 0 && index < covered.length) covered[index] = (covered[index] ?? 0) + 1

  const geo = run.lumen.conduits.get(inch.pose.conduitId)
  const detector = run.constrainedDetectors.get(agent.spec.id)
  if (geo === undefined || detector === undefined) return

  // Which way is it looking? The crawler has no free rotation inside a bore, so its
  // only bearing is the direction of travel — which is the direction of the route
  // step it is executing, or forward when idle.
  const step = inch.route === null ? undefined : inch.route.steps[Math.min(inch.routeIndex, inch.route.steps.length - 1)]
  const direction: 1 | -1 = step === undefined || step.toArc >= inch.pose.arc ? 1 : -1

  const noise =
    run.config.noiseMultiplier === 0
      ? 0
      : (run.rng.next() - 0.5) * 2 * BORE_RANGE_NOISE * run.config.noiseMultiplier

  const found = detectBoreObstruction(
    agent.spec.id,
    run.tick,
    detector,
    geo,
    run.conduitObstructions.get(inch.pose.conduitId) ?? [],
    inch.pose.arc,
    direction,
    agent.spec.depthRange,
    noise,
  )
  if (found === null) return

  // Pushed as a first-class candidate rather than only logged, so the report and the
  // per-class metrics can see it and so `announce` can derive the escalation from it
  // by the same path every other finding takes. A finding that exists only in the log
  // is a finding nothing else in the system can reason about.
  run.candidates.push({
    id: found.id,
    detectorId: 'constrained.obstruction',
    predictedClass: 'blocked_vent',
    agentId: agent.spec.id,
    tick: found.tick,
    x: found.x,
    y: found.y,
    z: found.z,
    // Half-extents from the bore, so a blockage reads as filling the pipe rather than
    // as a point. The report's evidence column is where that shows up.
    halfExtents: [geo.conduit.bore, geo.conduit.bore, geo.conduit.bore],
    confidence: found.confidence,
    magnitude: 1,
    manifold: 'constrained',
    // One sensor, no corroboration, and the sensor cannot even classify what it hit.
    unverified: true,
  })

  run.log.push({
    tick: run.tick,
    kind: 'anomaly.candidate',
    agentId: agent.spec.id,
    manifold: 'constrained',
    data: {
      confidence: found.confidence,
      magnitude: 1,
      x: found.x,
      z: found.z,
    },
  })
}

/** Range noise on the bore scan, metres at noiseMultiplier 1. */
export const BORE_RANGE_NOISE = 0.02

// ---------------------------------------------------------------------------
// Metrics. Spec §9.1, §9.7
// ---------------------------------------------------------------------------

export type RunMetrics = {
  readonly tick: number
  readonly simSeconds: number
  readonly coverageFraction: number
  readonly observedCells: number
  readonly totalCells: number
  /** The control condition: spec §9.7. Must be 1.0 at zero noise. */
  readonly coverageComplete: boolean
  readonly faults: number
  readonly stranded: number
  readonly starved: number
  readonly energyUsedWh: number
  readonly batteryRemaining: readonly number[]
  readonly logHash: string
  readonly logTruncated: boolean
}

export function measure(run: SimRun, requiredObservation = 2): RunMetrics {
  const cov = coverage(run.grid, run.mask, requiredObservation)

  const faults = run.log.count('agent.faulted')
  const stranded = run.log.count('agent.stranded')
  const starved = run.log.count('job.starved')

  let energy = 0
  const battery: number[] = []
  for (const a of run.agents) {
    energy += a.energyUsed
    battery.push(a.battery)
  }

  return {
    tick: run.tick,
    simSeconds: run.tick * DT,
    coverageFraction: cov.observedFraction,
    observedCells: cov.observedCells,
    totalCells: cov.totalCells,
    coverageComplete: cov.observedFraction >= 0.999,
    faults,
    stranded,
    starved,
    energyUsedWh: energy,
    batteryRemaining: battery,
    logHash: run.log.hash(),
    logTruncated: run.log.isTruncated,
  }
}

/**
 * Cells never observed, for the report's gap list. Spec §8.2 rule 2 — absent
 * evidence must be reported, not omitted.
 */
export function coverageGaps(run: SimRun, requiredObservation = 2): Array<{ x: number; z: number }> {
  return uncoveredCells(run.grid, run.mask, requiredObservation)
}

// ---------------------------------------------------------------------------
// The market. Spec §6 — announce, bid, award, monitor.
// ---------------------------------------------------------------------------

/**
 * One tick of job allocation.
 *
 * The order is fixed and the reason is that each stage consumes the previous
 * one's output: announcements create jobs, bids are collected *inside* the bid
 * window, and awards happen only when the window closes. Announcing and awarding
 * in the same tick would make BID_WINDOW meaningless and turn the auction into a
 * first-come-first-served queue, which is the thing S8 exists to test against.
 */
export function stepMarket(run: SimRun): void {
  announce(run)
  escalate(run)
  collectBids(run)
  award(run)
  monitor(run)
}

/**
 * Capability handoff, spec §6.4 mechanism 1.
 *
 * ## What this does
 *
 * A crawler suspicion cannot be actioned where it was raised: nothing with
 * `sense.thermal` can reach 8 m into a 70 mm pipe. So each suspicion is escalated to
 * the **nearest port the crawler can reach**, as a `verify_thermal` job on the
 * *ground* manifold. A ground bot drives there and samples the air and the wall
 * around the penetration.
 *
 * ## What it deliberately does not do
 *
 * It does not carry the finding *to* the port. There is no physical co-location
 * mechanism in v1 — §7.1 cut docking — so this is a logical escalation: the
 * coordinator knows the finding and the agent that could confirm it, and the ground
 * bot is dispatched to the port where the evidence survives. Spec §6.4 mechanism 2
 * (executing a job in two stages across a port, inheriting the chunk transform) is
 * **not** implemented; this is mechanism 1 only, and the distinction is worth keeping
 * because mechanism 2's gate is about map registration, not about confirmation.
 *
 * ## What the confirmation means
 *
 * Weakly. A thermal-capable agent at the penetration finds corroborating evidence
 * *near the port*, not inside the pipe. So `handoffs.confirmed` is not "the defect is
 * real"; it is "something else the swarm can see agrees". The rate is reported
 * because it is the number that decides whether the constrained manifold is worth
 * putting a crawler into at all.
 */
function escalate(run: SimRun): void {
  for (const record of run.jobs.values()) {
    if (record.job.state !== 'announced') continue
    if (record.job.handoffFrom === undefined) continue
    // Decided once. Without this the tally counted one escalation every tick the job
    // sat in its bid window, and reported 26 unconfirmations from 2 handoffs — a
    // rate computed over re-decisions rather than over decisions.
    if (record.confirmation !== undefined) continue

    const corroborated = corroboratingCandidatesNear(run, record.job.region)
    record.confirmation = corroborated.length > 0
    if (record.confirmation) run.handoffs.confirmed++
    else run.handoffs.unconfirmed++

    run.log.push({
      tick: run.tick,
      kind: record.confirmation ? 'job.handed_off' : 'job.failed',
      jobId: record.job.id,
      agentId: record.awardedTo ?? undefined,
      data: {
        confirmation: record.confirmation ? 1 : 0,
        corroboratingCandidates: corroborated.length,
        raisedBy: record.job.handoffFrom.handedOffBy.length,
      },
    })
  }
}

/**
 * Evidence that a thermal-capable agent found near an escalated port.
 *
 * Restricted to *thermal* candidates, because confirming a thermal-suspicion with a
 * thermal reading is the only thing that means anything. Counting any candidate at
 * all would let a geometric detection elsewhere in the room "confirm" a pipe, which
 * is the kind of looseness that turns a 0% confirmation rate into a comfortable one.
 *
 * The candidates considered are the ones raised *before* the escalation, so a finding
 * that the handoff itself provoked cannot corroborate itself.
 */
function corroboratingCandidatesNear(run: SimRun, region: Aabb): Candidate[] {
  const centre = regionCentre(region)
  return run.candidates.filter(
    (c) =>
      c.tick < run.tick &&
      (c.detectorId === 'thermal.baseline' || c.detectorId === 'thermal.absolute') &&
      Math.abs(c.x - centre.x) <= HANDOFF_CORROBORATION_RADIUS &&
      Math.abs(c.z - centre.z) <= HANDOFF_CORROBORATION_RADIUS,
  )
}

/**
 * How near a port corroborating evidence must be, metres.
 *
 * Sized to the port's own clearance rather than to a room: the question is "is the
 * wall around this penetration showing something", and a metre away is a different
 * piece of wall.
 */
export const HANDOFF_CORROBORATION_RADIUS = 0.8

/**
 * Build the escalation job for a constrained-manifold suspicion.
 *
 * The region is the **port**, not the defect. That is the whole content of mechanism
 * 1: the finding cannot be serviced where it was raised, so the job is re-anchored to
 * the nearest place an agent holding the missing capability can actually stand.
 *
 * Priority follows the crawler's own confidence, which is below `CONFIDENCE_MIN` by
 * construction — so an escalated suspicion queues *behind* a thermal anomaly a ground
 * bot measured. That ordering is deliberate. A suspicion from an agent that cannot
 * classify what it found is weaker evidence, and making it urgent would be the way to
 * get the constrained manifold serviced and also the way to make the ground
 * manifold's real findings queue behind it.
 */
function handoffJobFor(run: SimRun, candidate: Candidate, tick: number): JobRecord | null {
  const conduitId = conduitOf(run, candidate)
  if (conduitId === null) return null

  const portPositions = new Map<string, [number, number, number]>()
  for (const p of run.house.ports) portPositions.set(p.id, [p.position[0], p.position[1], p.position[2]])

  const port = handoffPortFor(run.lumen.endpoints, conduitId, portPositions)
  if (port === null) {
    // A conduit opening onto no port has nowhere to hand off to. Escalating anyway
    // would be a job with no reachable bidder — a starved job, and a number that
    // reads like a swarm failure rather than like an architectural fact.
    return null
  }

  const [px, py, pz] = port.position
  const half = HANDOFF_CORROBORATION_RADIUS
  const arc = conduitArcOf(run, candidate, conduitId)

  return {
    job: {
      id: `handoff-${candidate.id}`,
      type: 'verify_thermal',
      region: { minX: px - half, minY: 0, minZ: pz - half, maxX: px + half, maxY: py + 1.8, maxZ: pz + half },
      manifold: 'ground',
      port: port.portId,
      requiredCapabilities: ['sense.thermal'],
      priority: Math.round(candidate.confidence * 100),
      state: 'announced',
      announcedAtTick: tick,
      escalations: 1,
      handoffFrom: { conduitId, arc: arc ?? 0, handedOffBy: candidate.agentId },
    },
    output: { kind: 'thermalMap', resolution: 0.05, minConfidence: 0.6 },
    closesAtTick: tick + BID_WINDOW,
    bids: [],
    awardedTo: null,
    arrivedAtTick: null,
    dwellTicks: 0,
    superseded: null,
    awardedPathLength: 0,
  }
}

/**
 * Which conduit a constrained candidate sits in.
 *
 * Recovered by matching the candidate's world position against the authored
 * obstacles — the same question the frame projection asks the world when it turns a
 * conduit pose into something renderable. It is a lookup against *geometry*, not a
 * read of the oracle's labels, so it carries no information the crawler did not have.
 */
function conduitOf(run: SimRun, candidate: Candidate): string | null {
  return conduitArcOf(run, candidate, null) === null ? null : conduitIdOf(run, candidate)
}

function conduitIdOf(run: SimRun, candidate: Candidate): string {
  for (const conduitId of run.conduitObstructions.keys()) {
    if (conduitArcOf(run, candidate, conduitId) !== null) return conduitId
  }
  return ''
}

/** Arc of the authored obstacle a candidate corresponds to, for logging and routing. */
function conduitArcOf(run: SimRun, candidate: Candidate, only: string | null): number | null {
  for (const [conduitId, obstacles] of run.conduitObstructions) {
    if (only !== null && conduitId !== only) continue
    const geo = run.lumen.conduits.get(conduitId)
    if (geo === undefined) continue
    for (const o of obstacles) {
      const at = positionAt(geo, o.arc)
      if (Math.abs(at[0] - candidate.x) < 1e-6 && Math.abs(at[2] - candidate.z) < 1e-6) return o.arc
    }
  }
  return null
}

function announce(run: SimRun): void {
  const tick = run.tick

  // Verification jobs from what the swarm has found. Suppressed spatially so a
  // single defect does not spawn a job per approach sighting — the same reasoning
  // as the detector's episode tracking, one layer up.
  for (const candidate of run.candidates) {
    if (candidate.tick !== tick) continue

    // Capability handoff, spec §6.4 mechanism 1. Handled *before* the generic path
    // because a constrained suspicion cannot be actioned where it was found: the
    // job has to be re-anchored to a port, on a different manifold, requiring a
    // capability the crawler does not have. That is a different job from what
    // `jobForCandidate` would produce.
    if (candidate.manifold === 'constrained' && candidate.confidence < CONFIDENCE_MIN) {
      const handoff = handoffJobFor(run, candidate, tick)
      if (handoff !== null) {
        run.jobs.set(handoff.job.id, handoff)
        run.jobTally.announced = (run.jobTally.announced ?? 0) + 1
        run.handoffs.raised++
        run.log.push({
          tick,
          kind: 'job.announced',
          jobId: handoff.job.id,
          manifold: 'ground',
          data: {
            priority: handoff.job.priority,
            manifoldScore: 0,
            handoff: 1,
            fromArc: handoff.job.handoffFrom?.arc ?? -1,
          },
        })
      }
      continue
    }

    if (hasNearbyJob(run, candidate.x, candidate.z, MARKET.spawnRadius)) continue

    const record = jobForCandidate(candidate, tick)
    if (record === null) continue
    run.jobs.set(record.job.id, record)
    run.jobTally.announced = (run.jobTally.announced ?? 0) + 1
    run.log.push({
      tick,
      kind: 'job.announced',
      jobId: record.job.id,
      manifold: record.job.manifold,
      data: { priority: record.job.priority, manifoldScore: record.job.manifold === 'ground' ? 1 : 0 },
    })
  }

  // Coverage jobs from frontier regions, nearest-first by path distance.
  //
  // The Stage C policy announced the first unobserved cell in scan order: 126 jobs
  // per 300 s, and it cost the swarm a detector's recall. Spec §11.12.
  // Coverage jobs from frontier regions, nearest-first by path distance.
  //
  // The Stage C policy announced the first unobserved cell in scan order: 126 jobs
  // per 300 s, and it cost the swarm a detector's recall. Spec §11.12.
  //
  // ## Only ground agents, and only the manifolds they can service
  //
  // The original guard was `a.spec.cls !== 'inchworm'`, which excluded the crawler and
  // nothing else. That was correct while every non-crawler was a ground bot, and became
  // wrong the moment a volumetric agent existed — a latent bug that Stage F is the first
  // thing able to trigger.
  //
  // Measured consequence, hover-only swarm over a 4 s mission:
  //
  //   jobs announced  1921   (against 5 for a ground bot)
  //   jobs completed     0
  //   wall clock     410 s  (against 492 ms)
  //
  // Two compounding faults. The hover bot was picked as the free agent to anchor *ground*
  // frontier jobs, and `agent.pose as Pose2` then read `x` and `z` off a `Pose3` — which
  // works by accident, because `Pose3` happens to have both fields. And because the ground
  // grid is never observed by a volumetric agent, every cell stays frontier forever, so the
  // whole house is re-announced every tick, and the market re-bids all of it every tick.
  //
  // The fix is the same shape as the market's: **do not announce work on a manifold no
  // agent in the swarm can service.** A crawler-only swarm should announce conduit work and
  // nothing else; a volumetric swarm should announce ceiling work and nothing else.
  const groundAgents = run.agents.filter((a) => a.spec.manifold === 'ground')
  const busy = groundAgents.filter((a) => a.currentJobId !== null).length
  const free = groundAgents.length - busy
  const budget = Math.max(0, free * MARKET.coverageJobsPerFreeAgent)

  if (budget > 0) {
    const agent = groundAgents.find((a) => a.currentJobId === null)
    if (agent !== undefined) {
      const pose = agent.pose as Pose2
      const regions = frontierRegions(run.grid, run.mask, pose.x, pose.z).slice(0, budget)
      for (const r of regions) {
        // Do not re-announce a region the market already knows about.
        if (hasNearbyJob(run, r.centroid.x, r.centroid.z, MARKET.spawnRadius)) continue

        const record = mapRegionJob(r.region, tick, Math.round(10 + r.support * 5))
        run.jobs.set(record.job.id, record)
        run.jobTally.announced = (run.jobTally.announced ?? 0) + 1
        run.log.push({
          tick,
          kind: 'job.announced',
          jobId: record.job.id,
          manifold: 'ground',
          data: {
            priority: record.job.priority,
            manifoldScore: 1,
            frontierCells: r.cells,
            support: r.support,
            pathDistance: r.distance,
          },
        })
      }
    }
  }

  // Conduit survey jobs from stretches no crawler has traversed.
  //
  // Same principle as the floor frontier: derived from the swarm's own record of
  // where it has been, not from the oracle. Announcing one job per authored defect
  // would hand the swarm an answer key on the one manifold nothing else can see.
  //
  // The target is the *midpoint of the longest unsurveyed run*, so a crawler sweeps
  // a stretch rather than creeping toward the next half-metre marker. Announcing
  // every unvisited metre would produce hundreds of jobs and a crawler that never
  // completes any of them.
  const idleCrawler = run.agents.find((a) => a.currentJobId === null && a.spec.cls === 'inchworm')
  if (idleCrawler !== undefined) {
    const gap = longestUnsurveyedRun(run, idleCrawler.spec.capabilities)
    if (gap !== null) {
      const geo = run.lumen.conduits.get(gap.conduitId)!
      const record = conduitScanJob(
        {
          conduitId: gap.conduitId,
          arc: gap.midArc,
          position: positionAt(geo, gap.midArc),
        },
        geo.class,
        tick,
        20,
      )
      run.jobs.set(record.job.id, record)
      run.jobTally.announced = (run.jobTally.announced ?? 0) + 1
      run.log.push({
        tick,
        kind: 'job.announced',
        jobId: record.job.id,
        manifold: 'constrained',
        data: {
          priority: record.job.priority,
          manifoldScore: 0,
          unsurveyedRun: gap.length,
          irreversible: isIrreversible(geo) ? 1 : 0,
        },
      })
    }
  }
}

/**
 * The longest contiguous stretch of conduit this agent could enter and has not
 * traversed, with its midpoint.
 *
 * Three filters, each of which is a distinct thing:
 * - **reachability** — a run in a disconnected component of the constrained
 *   manifold is not work, it is a wall. Announcing it forever produces a stream of
 *   jobs that starve and make the allocator look broken when it is working.
 * - **enterability** — the agent must physically fit. A 200 mm duct job is not for
 *   a bot with only `crawl.small`.
 * - **already handled** — if a live job covers the run, do not announce another.
 *
 * Returned in metres, midpoint rounded to the 5 cm grid the arc profile uses so the
 * same run always yields the same target.
 */
function longestUnsurveyedRun(
  run: SimRun,
  capabilities: readonly string[],
): { conduitId: string; length: number; midArc: number } | null {
  let best: { conduitId: string; length: number; midArc: number } | null = null

  for (const [conduitId, geo] of run.lumen.conduits) {
    const covered = run.conduitCoverage.get(conduitId)
    if (covered === undefined) continue
    if (!canEnter(geo, capabilities)) continue
    if (!conduitReachableFrom(run, conduitId)) continue

    let start = -1
    // A run must be at least MIN_GAP metres to be worth a job. Below that the
    // crawler would spend a full entry-and-exit to inspect 30 cm of bore, and the
    // constrained manifold's coverage would advance at a crawl.
    for (let i = 0; i < covered.length; i++) {
      const seen = (covered[i] ?? 0) > 0
      if (!seen && start < 0) start = i
      const atEnd = i === covered.length - 1
      if ((seen || atEnd) && start >= 0) {
        const fromArc = start * CONDUIT_ARC_RESOLUTION
        const toArc = i * CONDUIT_ARC_RESOLUTION
        const length = toArc - fromArc
        if (length >= MIN_SURVEY_RUN && (best === null || length > best.length)) {
          best = { conduitId, length, midArc: Math.round((fromArc + toArc) / 2) }
        }
        start = -1
      }
    }
  }

  if (best === null) return null

  // Suppress if a live job already covers this stretch.
  for (const record of run.jobs.values()) {
    if (record.job.state === 'done' || record.job.state === 'failed') continue
    if (record.job.conduit?.conduitId !== best.conduitId) continue
    return null
  }

  return best
}

/**
 * Can any crawler in this run reach this conduit at all?
 *
 * Routes from each crawler's current graph position. The constrained manifold turns
 * out not to be connected, so this is a real question with a real no.
 */
function conduitReachableFrom(run: SimRun, conduitId: string): boolean {
  for (const agent of run.agents) {
    if (agent.spec.cls !== 'inchworm') continue
    const from = run.lumenPositions.get(agent.spec.id) ?? { atPort: run.config.inchwormHomePort }
    const route = routeInLumen(run.lumen, from, { conduitId, arc: 0 })
    if (route.reachable) return true
  }
  return false
}

function collectBids(run: SimRun): void {
  const ctx = {
    grid: run.grid,
    mask: run.mask,
    tick: run.tick,
    jobs: run.jobs,
    load: run.load,
    lumen: run.lumen,
    lumenPositions: run.lumenPositions,
    missionSeconds: run.config.missionSeconds,
  }

  for (const record of run.jobs.values()) {
    if (record.job.state !== 'announced') continue
    if (run.tick > record.closesAtTick) continue

    for (const agent of run.agents) {
      if (agent.currentJobId !== null) continue
      // Spec §6.4 mechanism 3: an agent that failed in this part of the house is
      // excluded from it for a while. Silence about it is worse than an ineligible
      // bid, because the job would be re-announced to the same robot and fail again.
      if (isExcluded(run, agent.spec.id, record.job.region) && !exclusionWouldStarve(run, record)) continue
      const bid = buildBid(ctx, agent, record)
      if (!bid.eligible) continue
      // One bid per agent per job, re-evaluated each tick inside the window so a
      // bot that was elsewhere when the job appeared can still win it.
      const existing = record.bids.findIndex((b) => b.agentId === bid.agentId)
      if (existing >= 0) record.bids[existing] = bid
      else record.bids.push(bid)

      run.log.push({
        tick: run.tick,
        kind: 'bid.submitted',
        jobId: record.job.id,
        agentId: bid.agentId,
        data: {
          distance: bid.distance,
          batteryHeadroom: bid.batteryHeadroom,
          irreversibleRisk: bid.irreversibleRisk,
        },
      })
    }
  }
}

function award(run: SimRun): void {
  for (const record of run.jobs.values()) {
    if (record.job.state !== 'announced') continue
    if (run.tick < record.closesAtTick) continue

    const ranked = rankBids(record.bids.filter((b) => b.eligible))

    if (ranked.length === 0) {
      // No eligible bidder. Spec §6.5: escalate rather than drop, because a system
      // that quietly discards hard jobs posts a good completion rate and a bad
      // coverage score, and only one of those is visible to a stakeholder.
      if (isStarved(record, run.tick)) {
        record.job.state = 'failed'
        record.job.escalations += 1
        run.jobTally.failed = (run.jobTally.failed ?? 0) + 1
        run.log.push({
          tick: run.tick,
          kind: 'job.starved',
          jobId: record.job.id,
          data: { bids: record.bids.length, escalations: record.job.escalations },
        })
      }
      continue
    }

    const winner = ranked[0]!
    const runnerUp = ranked[1]

    // Capacity: one job at a time per agent. An agent already holding a job is
    // skipped above at bid time, so this is a guard rather than a rule.
    const holder = run.agents.find((a) => a.spec.id === winner.agentId)
    if (holder === undefined || holder.currentJobId !== null) continue

    record.job.state = 'active'
    record.awardedTo = winner.agentId
    holder.currentJobId = record.job.id
    holder.plan = []
    holder.planIndex = 0
    holder.goal = null

    // Regret: the winner's bid distance against the shortest any bidder offered.
    const bestDistance = Math.min(...ranked.map((b) => b.distance))
    run.regretSamples.push({ winnerDistance: winner.distance, bestDistance })

    // Only an award somebody else could have won carries information about the
    // allocator. Recorded here, at the point where the count is known, rather than
    // inferred downstream from the agent roster.
    if (ranked.length >= 2) run.contestedAwards++

    run.jobTally.awarded = (run.jobTally.awarded ?? 0) + 1
    run.jobTally.active = (run.jobTally.active ?? 0) + 1
    run.log.push({
      tick: run.tick,
      kind: 'job.awarded',
      jobId: record.job.id,
      agentId: winner.agentId,
      data: {
        winningDistance: winner.distance,
        runnerUpDistance: runnerUp?.distance ?? 0,
      },
    })
  }
}

function monitor(run: SimRun): void {
  for (const record of run.jobs.values()) {
    if (record.job.state !== 'active') continue

    // An agent that gave up on a job clears `currentJobId` and logs `job.failed` from
    // inside `tickAgent`, because only the agent knows it is wedged. This is where
    // that becomes a job *state*, so the tally stays conserved. Without it the job
    // sits in `active` with nobody holding it — work that vanished without anyone
    // deciding to drop it, which is the failure spec §6.5 exists to prevent.
    const holder = run.agents.find((a) => a.currentJobId === record.job.id)
    if (holder === undefined) {
      record.job.state = 'failed'
      record.job.escalations += 1
      run.jobTally.failed = (run.jobTally.failed ?? 0) + 1
      run.jobTally.active = Math.max(0, (run.jobTally.active ?? 1) - 1)
      // Exclude whoever held it from this region, so the same robot is not
      // handed the same gap back on the next announcement.
      if (record.awardedTo !== null) excludeFrom(run, record.awardedTo, record.job.region)
      continue
    }

    if (arrivedAt(run, holder, record)) {
      if (record.arrivedAtTick === null) {
        record.arrivedAtTick = run.tick
        record.awardedPathLength = 0
      }
      record.dwellTicks++
    } else {
      record.dwellTicks = 0
      record.arrivedAtTick = null
    }

    run.load.set(holder.spec.id, (run.load.get(holder.spec.id) ?? 0) + DT)

    if (record.dwellTicks >= DWELL_TICKS) {
      record.job.state = 'done'
      record.job.escalations += 0
      holder.currentJobId = null
      holder.plan = []
      holder.planIndex = 0
      holder.goal = null
      const inch = run.inchworms.get(holder.spec.id)
      // A crawler that is standing at a port has finished the conduit: drop its
      // pose so the next job is planned from the port it is actually at. Leaving a
      // stale arc behind would make the router start the next route mid-pipe,
      // which is the same "agent appears somewhere it cannot be" bug in miniature.
      if (inch !== undefined) inch.pose = null
      run.jobTally.done = (run.jobTally.done ?? 0) + 1
      run.jobTally.active = Math.max(0, (run.jobTally.active ?? 1) - 1)
      run.log.push({
        tick: run.tick,
        kind: 'job.done',
        jobId: record.job.id,
        agentId: holder.spec.id,
        data: { ticks: run.tick - record.job.announcedAtTick },
      })
    }
  }
}

/**
 * Has this agent actually turned up at its job?
 *
 * Three different tests, because there are three different kinds of work:
 * - ground/hover: inside the region's Aabb, with slack;
 * - conduit job: within 12 cm of the target **arc, in that conduit** — being in the
 *   right pipe at the wrong metre is not arrival, and the region Aabb is far too
 *   coarse to tell the difference;
 * - a crawler with no conduit target and no region it can enter: not arrived,
 *   which will starve the job. Correct rather than convenient.
 */
function arrivedAt(run: SimRun, agent: AgentState, record: JobRecord): boolean {
  const job = record.job

  if (job.conduit !== undefined) {
    const inch = run.inchworms.get(agent.spec.id)
    if (inch === undefined) return false
    return isAtTarget(inch, job.conduit)
  }

  if (isLumenPose(agent.pose)) {
    // A crawler at a port may still satisfy a small ground job it can reach by
    // reach, but it cannot satisfy a region job — it holds no `ground.drive`.
    // Region jobs require that capability, so reaching this branch means a
    // capability bug, and reporting "not arrived" is the safe reading.
    return false
  }

  return inRegion(job.region, agent.pose.x, agent.pose.z)
}

function hasNearbyJob(run: SimRun, x: number, z: number, radius: number): boolean {
  for (const record of run.jobs.values()) {
    if (record.job.state === 'done' || record.job.state === 'failed') continue
    const c = regionCentre(record.job.region)
    if (Math.abs(c.x - x) <= radius && Math.abs(c.z - z) <= radius) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Detection. Spec §1.5 — deterministic functions of observation history only.
// ---------------------------------------------------------------------------
// Detection. Spec §1.5 — deterministic functions of observation history only.
// ---------------------------------------------------------------------------

/**
 * Run every detector for one tick, over the agents' current poses.
 *
 * The detectors receive sensor *outputs*, never the world and never the oracle.
 * Everything they know about the environment they inferred while driving.
 */
export function detectThisTick(run: SimRun): Candidate[] {
  const out: Candidate[] = []
  const first = run.agents.find((a) => !isLumenPose(a.pose))
  if (first === undefined) return out

  const pose = first.pose as Pose2

  for (const agent of run.agents) {
    // A crawler's pose is (conduit, arc). Casting that to Pose2 yields
    // `x: undefined, z: undefined`, and every downstream ray cast then quietly
    // produces NaN bearings — which fail silently rather than throwing, so the
    // crawler appears to sense nothing while the detector registers as "ran and
    // found nothing". The empty-detection-looks-like-a-clean-building trap, one
    // level down. Skipped explicitly instead.
    if (isLumenPose(agent.pose)) continue

    // ## And the volumetric manifold, for a different reason
    //
    // A `Pose3` reaching here would be cast to `Pose2` and `p.theta` would be
    // `undefined`. That does not throw — it produces `NaN` bearings, and the thermal
    // detector then emits a candidate per ray.
    //
    // Measured, hover-only swarm: **480 candidates and 480 jobs per second of mission**,
    // none of them real, at 10 s per tick. The first version of this guard skipped only
    // the crawler, so it was correct while every non-crawler was a ground bot and became
    // wrong the moment a volumetric agent existed.
    //
    // This is an explicit absence, not an oversight: the volumetric manifold has **no
    // detector yet**. The hover bot's sensing output is currently the ceiling raster, which
    // records altitude genuinely (§11.31). Filing that under "ran and found nothing" would
    // be the empty-detection trap one level down, so it is skipped and said to be skipped.
    if (agent.spec.manifold !== 'ground') continue

    const p = agent.pose as Pose2
    const detector = run.detectors.get(agent.spec.id)
    const sensor = run.sensors.get(agent.spec.id)
    if (detector === undefined || sensor === undefined) continue

    // --- depth, then thermal ------------------------------------------------
    // The depth scan runs first and publishes its per-bearing range, which the
    // thermal sensor reuses. Two ray casts for the same geometry per tick is
    // waste, and sharing them keeps thermal localisation and the depth map
    // consistent with each other.
    const rangeOut = new Float64Array(DEPTH_RAYS).fill(agent.spec.depthRange)
    scanDepth(
      run.grid,
      run.mask,
      agent.spec.id,
      run.tick,
      p.x,
      p.z,
      p.theta,
      agent.spec.depthRange,
      run.rng,
      run.config.noiseMultiplier,
      rangeOut,
    )

    const scan = scanThermal(
      run.fields.temperature,
      agent.spec.id,
      run.tick,
      p.x,
      p.z,
      p.theta,
      agent.spec.depthRange,
      run.rng,
      run.config.noiseMultiplier,
      (bearing) => {
        // Nearest depth ray to this bearing. Nearest-neighbour rather than an
        // exact index because the two fans differ in ray count and angular span.
        //
        // This matters more than it looks: stubbing the range to a constant made
        // every thermal ray march its full 3 m *through* walls, so it sampled
        // anomalies behind masonry and then localised them to the wall face —
        // which is where the 2.3 m of thermal localisation error came from.
        const step = TWO_PI / DEPTH_RAYS
        let idx = Math.round(bearing / step) % DEPTH_RAYS
        if (idx < 0) idx += DEPTH_RAYS
        return rangeOut[idx]!
      },
    )

    const thermal = detectThermalBaseline(
      scan,
      detector,
      DETECTOR_THRESHOLDS.thermalBaselineK,
      DETECTOR_THRESHOLDS.thermalMinRays,
    )
    out.push(...thermal)
    for (const t of thermal) rememberThermal(detector, t)

    // The naive control. Scored separately so the comparison is a measurement.
    out.push(
      ...detectThermalAbsolute(
        scan,
        run.controlDetector,
        DETECTOR_THRESHOLDS.thermalDesignK,
        DETECTOR_THRESHOLDS.thermalDesignRiseK,
      ),
    )

    // --- humidity ----------------------------------------------------------
    const humidity = readHumidity(
      run.fields.humidity,
      agent.spec.id,
      run.tick,
      p.x,
      p.z,
      DT,
      sensor,
      run.rng,
      run.config.noiseMultiplier,
    )
    run.sensors.set(agent.spec.id, humidity.state)

    out.push(
      ...detectHumidityBaseline(
        humidity.reading,
        detector,
        DETECTOR_THRESHOLDS.humidityRh,
        p.x,
        p.z,
      ),
    )

    detector.airSum += readAir(
      run.fields.air,
      agent.spec.id,
      run.tick,
      p.x,
      p.z,
      DT,
      sensor,
      run.rng,
      run.config.noiseMultiplier,
    ).value
    detector.airCount++
  }

  // --- geometry ------------------------------------------------------------
  // Run every 10 ticks: these are properties of the map, not of the instant, and
  // re-deriving them at 10 Hz would multiply candidates for no new information.
  if (run.tick % 10 !== 0) return out

  out.push(
    ...detectClutter(first.spec.id, run.tick, blockedCellPositions(run), run.controlDetector),
  )
  out.push(
    ...detectCrackProxy(
      first.spec.id,
      run.tick,
      thinObstructions(run),
      DETECTOR_THRESHOLDS.crackProxy,
      run.controlDetector,
    ),
  )
  // The pest proxy fuses across a window, not a tick: geometry detectors run every
  // tenth tick while thermal findings are raised opportunistically, so passing
  // only this tick's candidates meant the two almost never coincided.
  const fusionDetector = run.detectors.get(first.spec.id) ?? run.controlDetector
  out.push(
    ...detectPestProxy(
      first.spec.id,
      run.tick,
      fusionDetector.recentThermal,
      obstructionPositions(run),
      DETECTOR_THRESHOLDS.pestRadius,
      run.controlDetector,
    ),
  )

  // --- blocked vents ------------------------------------------------------
  // Checked only when a ground port is close enough to have been sampled. The
  // detector's own quantile gate does the rest: an air reading that is merely
  // average is not evidence of stagnation.
  //
  // `isAirRegister`, not "has a ground side". Stage E added five constrained<->ground
  // ports for conduit entries, and treating those as ventilation registers made the
  // detector fire at the boiler flue penetration — one metre from the real blocked
  // vent it was already detecting. A port's manifold pair says which manifolds
  // touch; it does not say whether air is the medium, and now content says so.
  const airNow = run.fields.air
  const airValue = sampleField(airNow, pose.x, pose.z)
  for (const port of run.house.ports) {
    if (!isAirRegister(port)) continue
    if (port.a !== 'ground' && port.b !== 'ground') continue
    const px = port.position[0]
    const pz = port.position[2]
    if (sqrt((px - pose.x) * (px - pose.x) + (pz - pose.z) * (pz - pose.z)) > DETECTOR_THRESHOLDS.ventRange) {
      continue
    }
    const firstDetector = run.detectors.get(first.spec.id)
    if (firstDetector === undefined) continue
    out.push(
      ...detectBlockedVent(
        first.spec.id,
        run.tick,
        port.id,
        px,
        port.position[1],
        pz,
        airValue,
        run.fields.air.baselineAt(pose.x, pose.z),
        firstDetector,
        DETECTOR_THRESHOLDS.ventRelativeRise,
      ),
    )
  }

  for (const c of out) {
    run.log.push({
      tick: run.tick,
      kind: 'anomaly.candidate',
      agentId: c.agentId,
      manifold: c.manifold,
      data: {
        confidence: c.confidence,
        magnitude: c.magnitude,
        x: c.x,
        z: c.z,
      },
    })
  }

  void pose
  return out
}

/** Seen, mapped, non-blocking cells — the clutter detector's raw material. */
function blockedCellPositions(run: SimRun): Array<{ x: number; z: number }> {
  const g = run.grid
  const out: Array<{ x: number; z: number }> = []
  for (let cz = 0; cz < g.height; cz++) {
    for (let cx = 0; cx < g.width; cx++) {
      const i = cz * g.width + cx
      if (g.cells[i] !== CELL_BLOCKED) continue
      if (g.surfaceCount[i] === 0) continue
      out.push({ x: cellCenterX(g, cx), z: cellCenterZ(g, cz) })
    }
  }
  return out
}

/**
 * Any mapped obstruction, blocking or not — the pest proxy's raw material.
 *
 * A pest indicator behind an appliance needs the *appliance* as its context, and
 * appliances are OCCUPIED. Restricting this to non-blocking cells made the proxy
 * unable to fire anywhere a real infestation would be, which is precisely
 * backwards: the interest is always in the gap between something and a wall.
 */
function obstructionPositions(run: SimRun): Array<{ x: number; z: number }> {
  const g = run.grid
  const out: Array<{ x: number; z: number }> = []
  for (let cz = 0; cz < g.height; cz++) {
    for (let cx = 0; cx < g.width; cx++) {
      const i = cz * g.width + cx
      if (g.cells[i] !== CELL_OCCUPIED && g.cells[i] !== CELL_BLOCKED) continue
      if (g.surfaceCount[i] === 0) continue
      out.push({ x: cellCenterX(g, cx), z: cellCenterZ(g, cz) })
    }
  }
  return out
}

/**
 * Crack proxy input: occupied cells that form a **thin, isolated, linear feature**
 * rather than a wall or a piece of furniture.
 *
 * The first cut used "an occupied cell with three free 4-neighbours", which found
 * nothing at all: every authored obstacle is at least three cells thick, so no
 * cell of one ever has three free neighbours. A detector that returns an empty
 * set is indistinguishable from a detector that is not running, which is why it
 * took a stage-B diagnostic to notice rather than a failing test — the per-class
 * metric reported 0.00 and looked like a plausible result.
 *
 * The working definition: a connected component of occupied cells whose bounding
 * box is at most 2 cells across on one axis, and which is small enough not to be
 * part of the wall shell. That is the shape of a fissure standing off a surface,
 * and it is geometrically distinct from both a wall and a sofa.
 */
function thinObstructions(run: SimRun): Array<{ x: number; z: number; score: number }> {
  const g = run.grid
  const visited = new Uint8Array(g.width * g.height)
  const out: Array<{ x: number; z: number; score: number }> = []

  for (let seedCz = 1; seedCz < g.height - 1; seedCz++) {
    for (let seedCx = 1; seedCx < g.width - 1; seedCx++) {
      const seed = seedCz * g.width + seedCx
      if (g.cells[seed] !== CELL_OCCUPIED || visited[seed] === 1) continue

      // Flood fill this component.
      const stack = [seed]
      visited[seed] = 1
      let count = 0
      let minX = seedCx
      let maxX = seedCx
      let minZ = seedCz
      let maxZ = seedCz
      let observedCells = 0

      while (stack.length > 0) {
        const i = stack.pop()!
        const ix = i % g.width
        const iz = (i - ix) / g.width
        count++
        if (g.surfaceCount[i]! > 0) observedCells++
        if (ix < minX) minX = ix
        if (ix > maxX) maxX = ix
        if (iz < minZ) minZ = iz
        if (iz > maxZ) maxZ = iz

        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = ix + dx
          const nz = iz + dz
          if (nx < 0 || nz < 0 || nx >= g.width || nz >= g.height) continue
          const ni = nz * g.width + nx
          if (visited[ni] === 1) continue
          if (g.cells[ni] !== CELL_OCCUPIED) continue
          visited[ni] = 1
          stack.push(ni)
        }
      }

      // A wall shell or a piece of furniture: too many cells to be a fissure.
      if (count > 60) continue
      if (count < 4) continue
      // Must be substantially observed before we claim to have seen it.
      if (observedCells < count * 0.5) continue

      const spanX = maxX - minX + 1
      const spanZ = maxZ - minZ + 1
      const thin = Math.min(spanX, spanZ) <= 2
      if (!thin) continue

      const midX = (minX + maxX) / 2
      const midZ = (minZ + maxZ) / 2
      // Score rises as the feature gets thinner and longer — that is what
      // separates a fissure from a small object.
      const thinness = 3 - Math.min(spanX, spanZ)
      const length = Math.max(spanX, spanZ)
      out.push({
        x: cellCenterX(g, midX),
        z: cellCenterZ(g, midZ),
        score: thinness + length / 6,
      })
    }
  }
  return out
}

/**
 * The pose an agent starts in, which depends on which manifold it lives on.
 *
 * Three cases, and the failure mode in each is the same: a pose from the wrong manifold is
 * *accepted* by the type system at the point of use and then silently misread. A `Pose2` has
 * no `y`, so a volumetric consumer reading it gets `undefined`; a `Pose3` handed to the
 * ground planner has no `theta`.
 *
 * - **inchworm** � no metric pose at all. It is standing at a port, and its position is
 *   graph state (`conduit`, `arc`, `offset`), not coordinates. Seeding it with a ground pose
 *   put it in the wrong coordinate frame and every `isLumenPose` check took the wrong branch.
 * - **hover** � `Pose3` at `spawn.y`. The height default of 1.2 m is eye height rather than
 *   floor level so the clearance model has something to measure; at y = 0 the blockage ratio
 *   would be computed against the floor and the bot would start life maximally penalised.
 * - **everything else** � `Pose2`, the ground manifold's own type.
 */
function seedPose(spec: AgentSpec, spawn: { x: number; z: number; theta: number }): Pose {
  if (spec.cls === 'inchworm') return { conduitId: '', arc: 0, offset: 0, roll: 0 } as const
  if (spec.manifold === 'volumetric') {
    return {
      x: (spec.spawn ?? spawn).x,
      y: spec.spawn?.y ?? 1.2,
      z: (spec.spawn ?? spawn).z,
      roll: 0,
      pitch: 0,
      yaw: (spec.spawn ?? spawn).theta,
    } as const
  }
  return {
    x: (spec.spawn ?? spawn).x,
    z: (spec.spawn ?? spawn).z,
    theta: (spec.spawn ?? spawn).theta,
  } as const
}
