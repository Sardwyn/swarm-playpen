/**
 * Shared value types for the simulation core.
 *
 * Engine-agnostic by construction: no `three` import, no class instances, no
 * engine types anywhere under `src/sim/`. Enforced by
 * `test/boundary/no-render-imports.test.ts`.
 *
 * Conventions: metres, seconds, radians, joules, watts, hours. One world frame.
 * `y` is up. See spec §10 for the constant contract.
 */

// ---------------------------------------------------------------------------
// Identifiers. Stable and sortable; never reused. See spec §1.4 — iterate by
// stable ID, never by hash or insertion order.
// ---------------------------------------------------------------------------

export type AgentId = string
export type JobId = string
export type PortId = string
export type RegionId = string
export type ManifoldId = string

/** The three movement manifolds. Spec §2.5. */
export type Manifold = 'ground' | 'constrained' | 'volumetric'

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Axis-aligned bounding box in the world frame. */
export type Aabb = {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}

/** Pose in the ground manifold: 2-D position plus heading. Spec §5.1. */
export type Pose2 = {
  readonly x: number
  readonly z: number
  readonly theta: number
}

/** Pose in the volumetric manifold. Spec §5.4. */
export type Pose3 = {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly roll: number
  readonly pitch: number
  readonly yaw: number
}

/**
 * Pose in the constrained manifold. Spec §2.5 — deliberately NOT a metric pose.
 * A pipe has no isometric 2-D patch, so there is nothing for scan matching to
 * match against, and modelling it as (x, z, theta) would be a fiction.
 */
export type PoseLumen = {
  readonly conduitId: string
  /** Arc length along the conduit polyline, metres. */
  readonly arc: number
  /** Lateral offset from the centreline, bounded by bore. */
  readonly offset: number
  /** Body rotation about the conduit axis, radians. */
  readonly roll: number
}

export type Pose = Pose2 | Pose3 | PoseLumen

export function isLumenPose(p: Pose): p is PoseLumen {
  return 'conduitId' in p
}

export function isPose3(p: Pose): p is Pose3 {
  return 'y' in p
}

// ---------------------------------------------------------------------------
// House geometry
// ---------------------------------------------------------------------------

/** An axis-aligned box obstacle: wall, furniture, appliance. */
export type BoxObstacle = {
  readonly id: string
  readonly manifold: Manifold
  readonly aabb: Aabb
  /** Blocks movement (true) or only perception (false). */
  readonly blocking: boolean
  /** Surface material tag. Drives depth-cluster segmentation in Stage B. */
  readonly material: string
}

/** A named navigable space on the ground manifold. */
export type Room = {
  readonly id: string
  readonly name: string
  readonly aabb: Aabb
}

/**
 * A named enclosed space in the volumetric manifold.
 *
 * The counterpart of a `Room`, one manifold up. The house has none worth naming —
 * its space above the ceiling is one attic — but a vessel has two enclosed
 * volumes above the working deck, and one of them is the largest space on the
 * vessel and the one a robot cannot enter.
 */
export type Volume = {
  readonly id: string
  readonly name: string
  readonly aabb: Aabb
}

/**
 * A typed connector between manifolds. Spec §2.4 — manifolds touch only at
 * ports, and this is the structural rule that makes handoff and recombination
 * expressible at all.
 */
/**
 * What a port is *for*. Spec §2.4.
 *
 * The manifold pair says which manifolds touch. It does **not** say what the thing
 * is, and inferring that from the manifolds was a Stage E bug: a port joining
 * constrained to ground is a pipe leaving a wall, and the blocked-vent detector was
 * treating all five of them as air registers because they happened to satisfy
 * "one side is ground". It fired a candidate at the boiler flue penetration, one
 * metre from a real blocked vent — a true positive by coincidence, and a detector
 * that got it right for the wrong reason.
 *
 * So the distinction is authored rather than guessed:
 * - `vent` — an air path. The air field means something here, and a VOC rise near
 *   it is evidence of poor extraction.
 * - `conduit_entry` — a bore the inchworm can enter. Air measurements taken beside
 *   a pipe penetration say nothing about ventilation.
 * - `hatch` — a passage between spaces. Air flows, but it is not a register.
 */
export type PortKind = 'vent' | 'conduit_entry' | 'hatch'

export type Port = {
  readonly id: PortId
  readonly a: Manifold
  readonly b: Manifold
  readonly position: readonly [number, number, number]
  readonly radius: number
  /** Defaults to `vent`, which is what every Stage A–D port was implicitly. */
  readonly kind?: PortKind
}

/** Is this port an air register, i.e. a place a ventilation fault can occur? */
export function isAirRegister(port: Port): boolean {
  return (port.kind ?? 'vent') === 'vent'
}

/**
 * A conduit on the constrained manifold. Spec §2.2.
 *
 * A polyline swept with a bore radius. **Not a volume** — the inchworm's world is
 * one-dimensional along the arc plus a bounded lateral offset, and modelling it as
 * a 3-D occupancy volume would be a lie that makes the navigation problem look
 * easy. The consequence shows up in SLAM (§5.3): there is no isometric 2-D patch
 * inside a bore, so scan matching is meaningless there and localisation has to be
 * graph-relational instead.
 */
export type Conduit = {
  readonly id: string
  readonly name: string
  /** Bore radius, metres. `crawl.small` reaches ≤0.08; `crawl.medium` ≤0.25. */
  readonly bore: number
  /** Centreline, at least two points. */
  readonly points: readonly (readonly [number, number, number])[]
  /** Port at the first point, if the conduit opens onto one. */
  readonly startPort?: PortId
  /** Port at the last point. A conduit with the same port at both ends is a loop. */
  readonly endPort?: PortId
  /**
   * Authored landmarks at known arc positions — tees, elbows, terminations.
   *
   * These are the inchworm's only absolute fix. Revisiting one is a loop closure,
   * and it is what stops arc-length drift from being unbounded (spec §5.3).
   */
  readonly features: readonly { readonly arc: number; readonly kind: string }[]
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentClass = 'ground' | 'inchworm' | 'hover'

/** Spec §3.1: the inchworm, and the two traps that make it interesting. */
export const INCHWORM: AgentSpec = {
  id: 'inch-01',
  cls: 'inchworm',
  manifold: 'constrained',
  radius: 0.04,
  height: 0.04,
  minTurnRadius: 0,
  cruiseSpeed: 0.09,
  maxSpeed: 0.14,
  capabilities: [
    'crawl.small',
    'crawl.medium',
    'sense.depth',
    'sense.imu',
    'map.graph',
    // sense.humidity is deliberately absent. Spec 3.2's capability list does not
    // include it, and an earlier version of this file granted it - which quietly
    // removed the reason capability handoff has to exist. With a scalar sensor the
    // crawler could partly corroborate its own findings and the escalation in spec
    // 6.4 would never have fired. What it has is sense.depth, so the only finding
    // it can raise is geometric, and the only handoff available is to an agent with
    // a thermal sensor. The constraint is the mechanism.
    'map.merge',
  ],
  powerCruise: 9,
  powerSensors: 8,
  powerPeak: 16,
  batteryWh: 12,
  depthRange: 0.4,
}

/**
 * Spec §3.3: the hover bot. Stage F.
 *
 * ## The number that decides everything is 86 W against a 22 Wh pack
 *
 * 86 W hover draw plus 12 W sensors is **4.4x worse endurance than the ground bot**,
 * which cruises at 22 + 14 = 36 W on a 38 Wh pack. The hover bot carries 58% less
 * energy while burning 4x the power, so it is not a strictly better ground bot - it is
 * the only agent that can work above 1.0 m, at a price.
 *
 * That price is the reason the stage gate says "hover endurance respected by
 * allocation". It is also an awkward pairing with spec §11.26, where the S8 kill
 * condition removed battery from the bid ranking because it was measured inert. The two
 * are reconcilable and the reconciliation has to be measured rather than argued:
 *
 * - The **rank** term was inert at nominal with two *identical* bots 10 m apart, because
 *   neither could ever run out. It said nothing about a 4.4x-worse agent.
 * - An **eligibility filter** is a different mechanism from a ranking weight, and the
 *   original code's own note said battery was "scored, not filtered" as a deliberate
 *   choice. Re-introducing it is therefore a change of policy, not a reversal of §11.26,
 *   and it needs its own evidence.
 *
 * So the endurance check is run as an experiment in `stage-f-endurance.test.ts` rather
 * than assumed in either direction.
 *
 * ## Ceiling clearance is a soft constraint, and that reading is the spec's
 *
 * §3.3 lists "maintain altitude in a 0.9 m attic **without cost penalty**" under
 * *Cannot*. Read carefully that is not "cannot enter" - it is "entering is allowed and
 * costs". Spec open question 1 asks whether the 1.0 m clearance makes a low attic
 * "unreachable in practice, or just expensive", which only makes sense if it is
 * reachable at a price. So `HOVER_CLEARANCE_M` is a threshold below which
 * `hoverClearancePenalty` rises, not a wall.
 *
 * The content gives this something to bind on: the attic over the hall has **0.90 m**
 * of headroom (`test/world/stage-f-precondition.test.ts`).
 *
 * ## What is reduced, stated rather than hidden
 *
 * Spec §3.3 gives "full 6-DoF attitude, ±0.4 m/s, ±40 °/s". What is implemented is
 * **position and yaw as controlled degrees of freedom, plus a tracked tilt magnitude**.
 * Tilt is not decorative: it is what `hoverClearancePenalty` and the power model read,
 * because holding position in a narrow space means fighting induced flow, and that cost
 * is the decision-relevant consequence. What is *not* modelled is attitude control as a
 * dynamics problem — no rotor mixing, no aerodynamic cross-coupling. Recorded as a cut in
 * spec §12 rather than left for a reader to discover.
 */
export const HOVER: AgentSpec = {
  id: 'hover-01',
  cls: 'hover',
  manifold: 'volumetric',
  /** Body across rotors, spec §3.3. Half of it is the clearance-relevant radius. */
  radius: 0.12,
  height: 0.24,
  minTurnRadius: 0,
  cruiseSpeed: 0.4,
  maxSpeed: 0.4,
  capabilities: [
    'hover.stable',
    'sense.depth',
    'sense.thermal',
    // sense.rgb is declared and **deliberately unused** until the deferred RGB
    // work lands, per spec §4.6. Carrying the token without a sensor behind it would
    // let a ceiling job be awarded to the hover bot on the strength of a capability it
    // cannot exercise, which is the "declaration is decoration" failure in capability
    // form.
    'sense.rgb',
    'sense.imu',
    'map.local',
    'map.merge',
    // sense.humidity is absent for the same reason the inchworm lacks it, and for a
    // stronger one: it is the only volumetric agent, so granting it would silently
    // repair `ml-03`, the fifth member of the structurally-undetectable family. The
    // defect stays broken and visible rather than being absorbed by a capability.
  ],
  /** The dominant draw. Spec §3.3 - 4x the ground bot's cruise. */
  powerCruise: 86,
  powerSensors: 12,
  powerPeak: 104,
  batteryWh: 22,
  depthRange: 4.5,
}

/**
 * Ceiling clearance, spec §3.3: the lowest ceiling the bot can hold station under
 * without penalty. Below this, `hoverClearancePenalty` climbs.
 */
export const HOVER_CLEARANCE_M = 1.0

/**
 * Clearance is a **cost**, not a wall, and this is the exponent on the shortfall.
 *
 * 0 means free, 1 means the shortfall is charged in full. It is a knob rather than a
 * measurement because the honest answer is not known yet - spec open question 1 asks
 * whether low-clearance flight is expensive or impossible, and picking a value before
 * measuring would decide the question by fiat. Stage F measures the sensitivity instead.
 */
export const HOVER_CLEARANCE_COST = 1

/**
 * Cost of lateral acceleration, as a fraction of the hover draw.
 *
 * Tilt is what makes a rotorcraft accelerate sideways, so the power goes with tilt rather
 * than with distance travelled � which is why the ground bot's model (moving vs not) is
 * the wrong shape for this agent. 0.30 means full commanded tilt roughly triples the
 * hover draw, which is the right order for a small multirotor at 0.4 m/s and is stated
 * rather than fitted: it has not been tuned against anything, and Stage F measures
 * whether it matters.
 */
export const HOVER_TILT_COST = 0.3

export type Capability =
  | 'ground.drive'
  | 'crawl.small'
  | 'crawl.medium'
  | 'hover.stable'
  | 'sense.depth'
  | 'sense.thermal'
  | 'sense.humidity'
  | 'sense.rgb'
  | 'sense.imu'
  | 'map.local'
  | 'map.graph'
  | 'map.merge'
  | 'recal.port'

export type AgentSpec = {
  readonly id: AgentId
  readonly cls: AgentClass
  readonly manifold: Manifold
  /**
   * Where this agent starts, overriding the run's spawn.
   *
   * Needed because two agents sharing a dock is not a second agent — they would walk
   * in formation and never compete for a job, so the allocator would look evaluated
   * while measuring nothing. Separation is what creates the contention S8 needs.
   *
   * Omitted means "use the run's spawn", which keeps the single-agent reference
   * configuration unchanged.
   */
  readonly spawn?: {
    readonly x: number
    readonly z: number
    readonly theta: number
    /**
     * Starting height, for volumetric agents. Spec §5.4.
     *
     * Optional because a ground agent has no height, and a field that must be present but
     * meaningless is a field that gets filled with a plausible lie. `seedPose` defaults a
     * volumetric agent to 1.2 m — eye height — so that the clearance model starts with
     * something to measure rather than with the bot on the floor.
     */
    readonly y?: number
  }
  /** Half-width for ground/hover collision; inchworm uses bore-limited lateral. */
  readonly radius: number
  readonly height: number
  readonly minTurnRadius: number
  readonly cruiseSpeed: number
  readonly maxSpeed: number
  readonly capabilities: readonly Capability[]
  /** Watts. Subsystem split lives in power.ts. */
  readonly powerCruise: number
  readonly powerSensors: number
  readonly powerPeak: number
  readonly batteryWh: number
  readonly depthRange: number
}

/** IMU calibration state. Spec §4.5.1 — the three-state model. */
export type CalibrationState = 'uncalibrated' | 'calibrated' | 'drifted'

export type AgentState = {
  /**
   * Consecutive ticks with no forward progress. Spec §7.4.
   *
   * Reset to 0 by any movement. Crossing `STALL_LIMIT_TICKS` makes the agent
   * stranded: the run logs it, the agent drops its plan and releases its job.
   */
  stalledTicks: number
  readonly spec: AgentSpec
  readonly pose: Pose
  readonly manifold: Manifold
  /** Fraction, 0..1. */
  battery: number
  /** Wh consumed to date. */
  energyUsed: number
  calibration: CalibrationState
  /** Ticks since last calibration. Drives the residual-bias decay. */
  ticksSinceCalibration: number
  /** True while executing the 2.0 s dock excitation routine. */
  calibrating: boolean
  /** Set when an agent cannot make progress. Consumed by the tick, never stored. */
  faulted: boolean
  /**
   * Current plan, held on the agent rather than recomputed per tick.
   *
   * A* from scratch every tick is both slow and non-deterministic in the
   * pathological case; replanning only when the plan is exhausted or invalid
   * makes the plan a function of the map, which is what the determinism test
   * needs.
   */
  plan: ReadonlyArray<{ x: number; z: number }>
  planIndex: number
  goal: { x: number; z: number } | null
  /** The job this agent is executing, or null when it is exploring. Spec §6. */
  currentJobId: JobId | null
  /** Cumulative path length this tick, so the market can score bid-vs-actual. */
  tickPathLength: number
  /**
   * 3-D plan for the volumetric manifold. Spec §5.4.
   *
   * Separate from `plan` rather than a union because a plan is homogeneous per
   * agent-manifold: the ground bot never holds a 3-D waypoint and the hover bot never
   * holds a 2-D one. Making them one type would invite a 2-D consumer to read a 3-D
   * waypoint and silently drop the height.
   */
  plan3: ReadonlyArray<{ x: number; y: number; z: number }>
  plan3Index: number
  /**
   * Tracked tilt magnitude, 0..1. Spec §3.3.
   *
   * The hover bot's controlled degrees of freedom are position and yaw; tilt is a tracked
   * quantity the power model reads. It is not integrated attitude dynamics — see
   * `sim/hover.ts` for why that reduction is deliberate and what it costs.
   */
  tilt: number
}

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

export type DepthPoint = {
  readonly x: number
  readonly y: number
  readonly z: number
  /** 0..1. Outlier points carry low confidence rather than being dropped. */
  readonly confidence: number
}

export type DepthScan = {
  readonly agentId: AgentId
  readonly tick: number
  readonly points: readonly DepthPoint[]
  readonly valid: boolean
  /**
   * Cells first observed by THIS scan. Carried in the scan rather than counted
   * in module state, so a run cannot depend on what a previous run observed.
   */
  readonly newlyObserved: number
}

export type ThermalReading = {
  readonly agentId: AgentId
  readonly tick: number
  /** Kelvin. */
  readonly temperature: number
  readonly confidence: number
}

export type HumidityReading = {
  readonly agentId: AgentId
  readonly tick: number
  /** 0..1 relative humidity. */
  readonly rh: number
  readonly confidence: number
}

/** Noised IMU sample. Spec §4.5. */
export type ImuSample = {
  readonly agentId: AgentId
  readonly tick: number
  /** Angular rate, rad/s. Contains bias. */
  readonly gyro: readonly [number, number, number]
  /** Linear acceleration, m/s^2. Contains bias. */
  readonly accel: readonly [number, number, number]
  readonly bias: readonly [number, number, number]
}

// ---------------------------------------------------------------------------
// Jobs. Spec §6.1
// ---------------------------------------------------------------------------

/**
 * Confidence the inchworm attaches to everything it finds. Spec §3.2, §6.4.
 *
 * Deliberately *below* the report's `CONFIDENCE_MIN` (0.6), and deliberately not
 * tunable.
 *
 * The inchworm has `sense.depth` and nothing else: no thermal, no air, no bearing
 * outside its own bore. A range finder bouncing off something can say "there is
 * something there" and nothing more — not root intrusion, not a collapsed joint, not
 * a bag of rubble. Any confidence it could honestly assert would be a claim about a
 * sensor it does not have.
 *
 * Publishing below the acceptance threshold is what makes the finding a
 * *suspicion*, which is the input spec §6.4's escalation consumes. Raising this to
 * meet `CONFIDENCE_MIN` would silence the crawler's entire contribution — and it
 * would look like an improvement: more precision, identical recall, one less agent
 * doing anything.
 *
 * The relationship to `CONFIDENCE_MIN` is asserted by a test rather than left to a
 * comment, because a future edit that raises this would not break anything visible.
 */
export const CONDUIT_SUSPICION_CONFIDENCE = 0.4

export type JobType =
  | 'map_region'
  | 'scan_pipe'
  | 'scan_duct'
  | 'scan_ceiling'
  | 'scan_appliance'
  | 'verify_thermal'
  | 'verify_moisture'
  | 'inspect_anomaly'
  | 'resolve_contested'

export type JobState =
  | 'announced'
  | 'awarded'
  | 'active'
  | 'blocked'
  | 'done'
  | 'failed'

export type Job = {
  readonly id: JobId
  readonly type: JobType
  readonly region: Aabb
  readonly manifold: Manifold
  readonly port?: PortId
  /**
   * Set when this job is an escalation of a finding raised on another manifold.
   * Spec §6.4 mechanism 1.
   *
   * Present on the job rather than only in the log so the coordinator can route
   * without re-deriving it: a `verify_thermal` at a *port*, with the defect 8 m away
   * inside a 70 mm pipe, is not the same job as a `verify_thermal` at a defect, and
   * nothing else about the two records says so.
   */
  readonly handoffFrom?: { readonly conduitId: string; readonly arc: number; readonly handedOffBy: AgentId }
  /**
   * Conduit target, for jobs on the constrained manifold. Spec §6.2.
   *
   * A conduit job cannot be expressed as an Aabb: the inchworm's pose is
   * (conduit, arc), and a box around a pipe is a different job from a box around a
   * room. Reusing `region` for both would mean a 2.1 m bore and a 3 m room are the
   * same addressable thing, and the arrival test would accept an agent standing
   * beside the pipe. So the target is typed and the arrival test follows it.
   */
  readonly conduit?: { readonly conduitId: string; readonly arc: number }
  readonly requiredCapabilities: readonly Capability[]
  readonly priority: number
  /** Mutable: the lifecycle is the state machine, spec §6.1. */
  state: JobState
  readonly announcedAtTick: number
  readonly decomposedFrom?: JobId
  escalations: number
}

// ---------------------------------------------------------------------------
// Typed event log. Spec §1.5 — a primary structure, not a debug byproduct.
// Every metric names the events it consumes; if a metric cannot, it is cut.
// ---------------------------------------------------------------------------

export type EventKind =
  | 'run.started'
  | 'run.finished'
  | 'agent.calibrated'
  | 'agent.battery_critical'
  | 'agent.stranded'
  | 'agent.faulted'
  | 'sensor.observation'
  | 'grid.cell_observed'
  | 'grid.revisited'
  | 'job.announced'
  | 'bid.submitted'
  | 'job.awarded'
  | 'job.handed_off'
  | 'job.starved'
  | 'job.done'
  | 'job.failed'
  | 'cluster.formed'
  | 'cluster.dissolved'
  | 'anomaly.candidate'
  /**
   * A crawler re-entered a landmark's band and corrected its arc. Spec §5.3.
   *
   * Its own kind rather than an `anomaly.candidate`, because a localisation fix is
   * not a finding. Filing closures as candidates put 2638 phantom defects in the
   * log for a 25 m crawl, every one of which the per-class metric would have
   * scored as a false positive against the oracle — the metric reporting the SLAM
   * system's bookkeeping as if it were the inspection system's output.
   */
  | 'agent.loop_closed'

export type SimEvent = {
  readonly tick: number
  readonly kind: EventKind
  readonly agentId?: AgentId
  readonly jobId?: JobId
  readonly manifold?: Manifold
  /** Free-form numeric detail. Named keys per kind; the detectors read these. */
  readonly data: Readonly<Record<string, number>>
}

// ---------------------------------------------------------------------------
// Simulation configuration. Every knob the scenarios sweep lives here.
// ---------------------------------------------------------------------------

export type SimConfig = {
  readonly seed: number
  readonly tickHz: number
  /** Global sensor noise multiplier. 0 is the control condition (spec §9.7). */
  readonly noiseMultiplier: number
  /** Length of one inspection mission, seconds. Spec §10. */
  readonly missionSeconds: number
  readonly groundCellSize: number
  /** Requires a port to return to. Spec §4.5.1. */
  readonly enableCalibration: boolean
  /**
   * Run the job market. Spec §6.
   *
   * Exists so detection can be measured on a *fixed* trajectory. S3 is the
   * detection baseline and must stay comparable across stages, and the Stage C
   * finding was that adding jobs changed the robot's path and therefore which
   * findings existed at all — `pest_indicator` went from recall 1.00 to 0.00 with
   * no change to the detector. Rather than let the baseline drift, the baseline
   * pins the policy: S3 turns jobs off and says so, and the job system is measured
   * separately by S8.
   */
  readonly enableJobs: boolean
  /**
   * Fraction of each agent's rated pack available at mission start. 0..1.
   *
   * A scenario knob, not a modelling change. Spec §4.5.1 and test-scenarios.md S6
   * both need degraded packs, and the alternative was defining a variant `AgentSpec`
   * per percentage — which would fork the agent identity and make two "the same bot
   * with less charge" indistinguishable from two different bots.
   *
   * Default 1. At nominal the ground bot spends about 5% of its 38 Wh pack over a
   * 300 s mission, so battery is not a binding constraint here; it binds under S6,
   * which is the only place the auction's battery term has any purchase.
   */
  readonly initialBatteryFraction: number
  readonly agents: readonly AgentSpec[]
  /**
   * Port the inchworm starts and idles at. Spec §3.2.
   *
   * It is a config value rather than a constant because it decides *which part of
   * the constrained manifold the swarm can work at all* — see
   * `lumenComponents`. The constrained manifold is not connected, so this single
   * field selects one component and makes the rest unreachable. That is a fact
   * about the house, and a scenario needs to be able to choose which fact it is
   * studying.
   */
  readonly inchwormHomePort: string
}

export const TICK_HZ = 10
export const DT = 1 / TICK_HZ

/** Spec §10: mission length over which residual bias decays 15% -> 60%. */
export const MISSION_DRIFT_HORIZON = 1800
/** Spec §4.5.1: dock excitation routine. */
export const IMU_CAL_DWELL = 2.0
