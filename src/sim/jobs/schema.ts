/**
 * Job schema and construction. Spec §6.1, §6.2.
 *
 * **Where jobs come from is a correctness question, not a convenience one.** At
 * Stage B the coordinator had no jobs at all. The tempting implementation is for
 * it to read the anomaly oracle and announce a job per defect — and that would be
 * a swarm that has been *told where the defects are*. Every §9.2 number would still
 * print, and every one of them would be meaningless.
 *
 * So jobs are spawned from what the swarm has actually found:
 *
 * - `map_region` from unobserved coverage. Nobody tells the robot what to explore.
 * - `inspect_anomaly` / `verify_*` from **detector candidates**, which is a
 *   suspicion, not a fact.
 *
 * The oracle stays behind the boundary. A job that exists because a detector fired
 * is a hypothesis the swarm has to test; that is the loop the whole project is
 * about.
 */

import type { Job, JobId, JobType, Capability, Manifold, Aabb } from '../types.ts'
import type { Candidate } from '../sim/detectors.ts'

/** Spec §10: BID_WINDOW. */
export const BID_WINDOW = 12
/** Spec §10: STARVATION_TIMEOUT. */
export const STARVATION_TIMEOUT = 40
/** Ticks an agent must hold station inside a job region before it is satisfied. */
export const DWELL_TICKS = 6
/** How close to the region centre counts as being on it. */
export const ARRIVAL_RADIUS = 0.35

/** Typed output contract. `done` means the spec is met, not that it looked. */
export type OutputSpec = {
  readonly kind: 'thermalMap' | 'moistureMap' | 'occupancyChunk' | 'anomalyReport' | 'mapAgreement'
  readonly resolution: number
  readonly minConfidence: number
}

export type JobRecord = {
  readonly job: Job
  readonly output: OutputSpec
  /** Tick the bid window closes. */
  readonly closesAtTick: number
  bids: Bid[]
  awardedTo: string | null
  /** Tick the winner reached the region, or null while travelling. */
  arrivedAtTick: number | null
  /** Ticks the winner has held station. */
  dwellTicks: number
  /** Set when this job replaced another, so handoff chains are traceable. */
  readonly superseded: JobId | null
  /** Path length the winner actually travelled, for the regret metric (spec §9.4). */
  awardedPathLength: number
  /**
   * For a handoff job: did a thermal-capable agent find corroborating evidence at the
   * port? Spec §6.4 mechanism 1.
   *
   * `undefined` means not yet decided, which is different from `false`. The
   * distinction matters because the confirmation rate is the number that says whether
   * putting a crawler into a pipe was worth it, and a rate computed over undecided
   * jobs would report a confident 0%.
   */
  confirmation?: boolean
}

export type Bid = {
  readonly agentId: string
  readonly distance: number
  /** Reported, not scored. Spec §9.3 energy accounting. */
  readonly batteryHeadroom: number
  /** 1 if the work is single-file for this agent. Vetoes the bid outright. */
  readonly irreversibleRisk: number
  readonly eligible: boolean
  /** Why an ineligible agent did not bid. Empty when eligible. */
  readonly reasons: readonly string[]
}

let jobCounter = 0

/** Reset the id counter. Runs must not share one (spec §1.4). */
export function resetJobIds(): void {
  jobCounter = 0
}

function nextJobId(prefix: string): JobId {
  jobCounter += 1
  return `${prefix}-${jobCounter}`
}

export type JobRequest = {
  readonly type: JobType
  readonly region: Aabb
  readonly manifold: Manifold
  readonly requiredCapabilities: readonly Capability[]
  readonly priority: number
  readonly output: OutputSpec
  /** Conduit target. Present for and only for constrained-manifold jobs. */
  readonly conduit?: { readonly conduitId: string; readonly arc: number }
}

/**
 * Capabilities a job type demands, per spec §6.2.
 *
 * The note there matters and is repeated here: capability requirements are about
 * **vantage**, not just access. A ceiling job needs the hover bot even when the
 * appliance is visible from the floor, because a thermal raster of a ceiling void
 * needs a vantage point inside the void.
 */
export const JOB_REQUIREMENTS: Readonly<Record<JobType, readonly Capability[]>> = {
  map_region: ['ground.drive'],
  scan_pipe: ['crawl.small'],
  scan_duct: ['crawl.medium'],
  scan_ceiling: ['hover.stable'],
  scan_appliance: ['ground.drive', 'sense.thermal'],
  verify_thermal: ['sense.thermal'],
  verify_moisture: ['sense.humidity'],
  inspect_anomaly: ['ground.drive'],
  resolve_contested: ['ground.drive'],
}

export function makeJob(request: JobRequest, tick: number): JobRecord {
  const id = nextJobId(request.type)
  return {
    job: {
      id,
      type: request.type,
      region: request.region,
      manifold: request.manifold,
      requiredCapabilities: request.requiredCapabilities,
      priority: request.priority,
      state: 'announced',
      announcedAtTick: tick,
      escalations: 0,
      ...(request.conduit === undefined ? {} : { conduit: request.conduit }),
    },
    output: request.output,
    closesAtTick: tick + BID_WINDOW,
    bids: [],
    awardedTo: null,
    arrivedAtTick: null,
    dwellTicks: 0,
    superseded: null,
    awardedPathLength: 0,
  }
}

export function regionCentre(region: Aabb): { x: number; y: number; z: number } {
  return {
    x: (region.minX + region.maxX) / 2,
    y: (region.minY + region.maxY) / 2,
    z: (region.minZ + region.maxZ) / 2,
  }
}

/** Is a pose inside the job's region, with slack? */
export function inRegion(region: Aabb, x: number, z: number, slack = ARRIVAL_RADIUS): boolean {
  return (
    x >= region.minX - slack &&
    x <= region.maxX + slack &&
    z >= region.minZ - slack &&
    z <= region.maxZ + slack
  )
}

/**
 * Spawn a verification job for something a detector flagged.
 *
 * The job type is chosen from what the candidate's detector *measured*, not from
 * the class it guessed — asking for thermal confirmation of a moisture finding
 * would be a coordinator that believes its own labels. High priority goes to
 * high-confidence findings, because a coordinator that treats a 0.2-confidence
 * blip as urgent has no priorities at all.
 */
export function jobForCandidate(candidate: Candidate, tick: number): JobRecord | null {
  const centre = { x: candidate.x, y: candidate.y, z: candidate.z }
  const extent = Math.max(candidate.halfExtents[0], candidate.halfExtents[2]) * 2

  const region: Aabb = {
    minX: centre.x - extent,
    minY: 0,
    minZ: centre.z - extent,
    maxX: centre.x + extent,
    maxY: 1.8,
    maxZ: centre.z + extent,
  }

  const priority = Math.round(candidate.confidence * 100)

  switch (candidate.detectorId) {
    case 'thermal.baseline':
    case 'thermal.absolute':
      return makeJob(
        {
          type: 'verify_thermal',
          region,
          manifold: candidate.manifold,
          requiredCapabilities: JOB_REQUIREMENTS.verify_thermal,
          priority,
          output: { kind: 'thermalMap', resolution: 0.05, minConfidence: 0.6 },
        },
        tick,
      )
    case 'humidity.baseline':
      return makeJob(
        {
          type: 'verify_moisture',
          region,
          manifold: candidate.manifold,
          requiredCapabilities: JOB_REQUIREMENTS.verify_moisture,
          priority,
          output: { kind: 'moistureMap', resolution: 0.05, minConfidence: 0.6 },
        },
        tick,
      )
    case 'geometry.clutter':
    case 'geometry.blocked_vent':
    case 'geometry.crack_proxy':
    case 'geometry.pest_proxy':
      // A geometric finding needs a look with the right instrument, and on the
      // ground manifold that is a thermal-capable ground bot.
      return makeJob(
        {
          type: 'inspect_anomaly',
          region,
          manifold: candidate.manifold,
          requiredCapabilities: JOB_REQUIREMENTS.inspect_anomaly,
          priority,
          output: { kind: 'anomalyReport', resolution: 0.05, minConfidence: 0.6 },
        },
        tick,
      )
    default:
      return null
  }
}

/** A coverage job over an unobserved region. Nobody tells the robot what is there. */
export function mapRegionJob(region: Aabb, tick: number, priority = 10): JobRecord {
  return makeJob(
    {
      type: 'map_region',
      region,
      manifold: 'ground',
      requiredCapabilities: JOB_REQUIREMENTS.map_region,
      priority,
      output: { kind: 'occupancyChunk', resolution: 0.05, minConfidence: 0 },
    },
    tick,
  )
}

/**
 * A survey job for a stretch of conduit. Spec §6.2, `scan_pipe` / `scan_duct`.
 *
 * ## Why this is spawned from unsurveyed conduits and not from the oracle
 *
 * The temptation is to announce a job per *authored defect*, which would hand the
 * swarm an answer key on a manifold nothing else in the system can see. It is
 * spawned from "this stretch of bore has never been traversed", which is a fact
 * about the swarm's own history, exactly like `map_region` is a fact about
 * unobserved floor.
 *
 * `region` is a zero-extent Aabb at the target's world position. It is not used
 * for arrival — `conduit` is — but it is kept populated because the report's job
 * table prints a region and an empty box is a lie about where the work was.
 */
export function conduitScanJob(
  target: { conduitId: string; arc: number; position: readonly [number, number, number] },
  boreClass: 'small' | 'medium' | 'large',
  tick: number,
  priority = 20,
): JobRecord {
  const [x, y, z] = target.position
  const type: JobType = boreClass === 'medium' || boreClass === 'large' ? 'scan_duct' : 'scan_pipe'

  return makeJob(
    {
      type,
      region: { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z },
      manifold: 'constrained',
      requiredCapabilities: JOB_REQUIREMENTS[type],
      priority,
      output: { kind: 'occupancyChunk', resolution: 0.05, minConfidence: 0 },
      conduit: { conduitId: target.conduitId, arc: target.arc },
    },
    tick,
  )
}

export type { Job, JobType, JobId, OutputSpec as JobOutputSpec }