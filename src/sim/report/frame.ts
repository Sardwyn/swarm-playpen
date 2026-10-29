/**
 * The viewer frame contract. Spec §8.3.
 *
 * The viewer is a *consumer*. It reads a `SimFrame` and never writes simulation
 * state — all state changes go through commands (ADR-001 §2.2). Producing the
 * frame here, rather than letting the viewer reach into `run.grid` and
 * `run.candidates`, is what keeps that boundary mechanical instead of a
 * convention: the viewer has no route into the simulation's internals to misuse.
 *
 * Everything in a frame is plain data — typed arrays and primitives — so a frame
 * can be rendered, logged, diffed or sent over a wire. That is the difference
 * between a system that is visible and one that is *interrogable*.
 */

import type { SimRun } from '../sim/run.ts'
import type { AgentState } from '../types.ts'
import { isLumenPose } from '../types.ts'
import { positionAt } from '../world/lumen.ts'
import { associateCandidates } from './metrics.ts'
import type { InspectionReport, Finding } from './report.ts'
import { CELL_OCCUPIED, CELL_BLOCKED } from '../world/geometry.ts'

export type AgentFrame = {
  readonly id: string
  readonly cls: string
  readonly x: number
  readonly y: number
  readonly z: number
  readonly heading: number
  readonly battery: number
  readonly currentJobId: string | null
  readonly currentJobType: string | null
  readonly faulted: boolean
}

export type JobFrame = {
  readonly id: string
  readonly type: string
  readonly state: string
  readonly x: number
  readonly z: number
  readonly awardedTo: string | null
  readonly priority: number
}

/** Optional overlay: the authored oracle. Debug view only, spec §8.3. */
export type TruthFrame = {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly cls: string
  readonly severity: number
  readonly manifold: string
}

/**
 * The volumetric coverage record, for one volumetric agent.
 *
 * The frame already carried the ground manifold's coverage as a per-cell
 * observation count. It did not carry the volumetric manifold's, and that is a gap
 * rather than an omission: on a vessel the interesting space is above the working
 * deck, and a frame that cannot say what was looked at up there cannot show the
 * most important fact about a boat — which is what was not.
 *
 * The raster is a plan projection, because a raster indexed by height would need a
 * 3-D structure to answer a question that is only ever asked per plan position.
 */
export type RasterFrame = {
  readonly agentId: string
  readonly cellSizeM: number
  readonly minX: number
  readonly minZ: number
  readonly width: number
  readonly depth: number
  /** Readings per cell. 0 means the agent never looked here. */
  readonly observations: Uint16Array
  /** Mean deviation from the ambient baseline, kelvin. */
  readonly meanDeviationK: Float32Array
}

export type SimFrame = {
  readonly tick: number
  readonly simSeconds: number
  readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number }
  readonly cellSize: number
  readonly gridWidth: number
  readonly gridHeight: number
  /** Per-cell state: 0 unknown, 1 free, 2 occupied, 3 blocked. */
  readonly cellState: Uint8Array
  /** Observation count per cell — drives "how well have we seen this" shading. */
  readonly observed: Uint32Array
  /** Passability mask, for the nav overlay. */
  readonly passable: Uint8Array
  readonly agents: readonly AgentFrame[]
  readonly jobs: readonly JobFrame[]
  readonly findings: readonly Finding[]
  /** Authored anomalies. For the debug overlay only, never for the report. */
  readonly truth: readonly TruthFrame[]
  /** Volumetric coverage, one raster per volumetric agent. */
  readonly rasters: readonly RasterFrame[]
  readonly report: InspectionReport
}

export type FrameOptions = {
  /** Include the authored oracle. Off by default and labelled when on. */
  readonly includeTruth?: boolean
}

/**
 * World position for the viewer, whichever manifold the agent is on.
 *
 * ## Why this is here and not in the sim core
 *
 * The viewer's job is to put a thing somewhere on screen, and "somewhere" is a
 * metric coordinate. A crawler's pose is `(conduit, arc)` — which is correct inside
 * the simulation and meaningless to a renderer. Projecting it to a world point
 * requires the lumen graph, and doing that projection *here*, at the boundary, is
 * what keeps the sim core free of presentation concerns (ADR-001 §1).
 *
 * The alternative — casting the pose to `{x, z}` — does not fail. It produces
 * `undefined`, which becomes `NaN` in the vertex buffer, and the agent vanishes from
 * the scene with no error anywhere. A crawler that renders nowhere looks exactly
 * like a crawler that has not started yet.
 *
 * ## Why it is exported
 *
 * The take recorder builds its own agent records, and it used to cast the pose
 * itself. The crawler therefore went back to being drawn at the origin for the
 * whole run — three hundred metres from the fuel line it was crawling — while
 * `frameFromRun` projected it correctly. One projection, exported, used by both:
 * a second copy of this logic is a second place for the bug to live.
 */
export function worldPositionOf(
  run: SimRun,
  agent: AgentState,
): { x: number; y: number; z: number; heading: number } {
  // The crawler is a special case, and it was a bug.
  //
  // The agent's own pose for an inchworm is the SEED it was created with — an
  // empty conduit id, because at the start it is standing at a port and has no
  // metric position. The graph position it actually holds lives on the separate
  // `InchwormState`. So projecting the agent's pose found no conduit, fell
  // through to the port fallback, found no port either, and returned the
  // origin: the crawler was drawn at (0, 0, 0) for the entire run, three
  // hundred metres from the fuel line it was crawling.
  //
  // So the crawler's position is read from where it actually is.
  if (agent.spec.cls === 'inchworm') {
    const inch = run.inchworms.get(agent.spec.id)
    const pose = inch?.pose
    if (pose !== null && pose !== undefined) {
      const geo = run.lumen.conduits.get(pose.conduitId)
      if (geo !== undefined) {
        const at = positionAt(geo, pose.arc)
        return { x: at[0], y: at[1], z: at[2], heading: pose.roll }
      }
    }
    // Standing at a port: report the port's own position, so the crawler is
    // still visible and still where it is.
    const portId = inch?.atPort ?? run.config.inchwormHomePort
    const port = run.house.ports.find((p) => p.id === portId)
    if (port !== undefined) {
      return { x: port.position[0], y: port.position[1], z: port.position[2], heading: 0 }
    }
    return { x: 0, y: 0, z: 0, heading: 0 }
  }

  if (isLumenPose(agent.pose)) {
    const geo = run.lumen.conduits.get(agent.pose.conduitId)
    if (geo === undefined) {
      const port = run.house.ports.find((p) => p.id === (run.inchworms.get(agent.spec.id)?.atPort ?? ''))
      if (port !== undefined) return { x: port.position[0], y: port.position[1], z: port.position[2], heading: 0 }
      return { x: 0, y: 0, z: 0, heading: 0 }
    }
    const at = positionAt(geo, agent.pose.arc)
    return { x: at[0], y: at[1], z: at[2], heading: agent.pose.roll }
  }

  const pose = agent.pose as { x: number; z: number; theta?: number; y?: number }
  return { x: pose.x, y: pose.y ?? 0.1, z: pose.z, heading: pose.theta ?? 0 }
}

/**
 * Build a frame from a run plus a report.
 *
 * The report is passed in rather than derived here, because the report is the
 * product and it has rules (spec §8.2) that a projection should not be able to
 * bypass. The caller builds it with `buildReport`; the frame carries it.
 */
export function frameFromRun(
  run: SimRun,
  report: InspectionReport,
  options: FrameOptions = {},
): SimFrame {
  const agents: AgentFrame[] = run.agents.map((a) => {
    const job = a.currentJobId === null ? undefined : run.jobs.get(a.currentJobId)
    const world = worldPositionOf(run, a)
    return {
      id: a.spec.id,
      cls: a.spec.cls,
      x: world.x,
      y: world.y,
      z: world.z,
      heading: world.heading,
      battery: a.battery,
      currentJobId: a.currentJobId,
      currentJobType: job?.job.type ?? null,
      faulted: a.faulted,
    }
  })

  const jobs: JobFrame[] = [...run.jobs.values()].map((record) => ({
    id: record.job.id,
    type: record.job.type,
    state: record.job.state,
    x: (record.job.region.minX + record.job.region.maxX) / 2,
    z: (record.job.region.minZ + record.job.region.maxZ) / 2,
    awardedTo: record.awardedTo,
    priority: record.job.priority,
  }))

  const truth: TruthFrame[] =
    options.includeTruth === true
      ? run.truth.anomalies.map((a) => ({
          x: a.position[0],
          y: a.position[1],
          z: a.position[2],
          cls: a.class,
          severity: a.severity,
          manifold: a.manifold,
        }))
      : []

  // The volumetric coverage, one raster per volumetric agent.
  //
  // Copied out of the sparse cell array into dense typed arrays, because a frame
  // that a renderer has to walk to find the non-empty cells is a frame that every
  // consumer has to walk. The rasters are small — one per agent, at 0.25 m — and
  // the copy is made once per frame.
  const rasters: RasterFrame[] = []
  for (const [agentId, raster] of run.hoverRasters) {
    const observations = new Uint16Array(raster.width * raster.depth)
    const meanDeviationK = new Float32Array(raster.width * raster.depth)
    for (let i = 0; i < raster.cells.length; i++) {
      const cell = raster.cells[i]
      if (cell === undefined) continue
      observations[i] = cell.observations
      meanDeviationK[i] = cell.meanDeviationK
    }
    rasters.push({
      agentId,
      cellSizeM: raster.cellSizeM,
      minX: raster.minX,
      minZ: raster.minZ,
      width: raster.width,
      depth: raster.depth,
      observations,
      meanDeviationK,
    })
  }

  return {
    tick: run.tick,
    simSeconds: run.tick / 10,
    bounds: {
      minX: run.house.bounds.minX,
      minZ: run.house.bounds.minZ,
      maxX: run.house.bounds.maxX,
      maxZ: run.house.bounds.maxZ,
    },
    cellSize: 0.05,
    gridWidth: run.grid.width,
    gridHeight: run.grid.height,
    // Copied, not aliased. The viewer gets a snapshot and cannot reach back
    // through it into the running simulation.
    cellState: run.grid.cells.slice(),
    observed: run.grid.observedCount.slice(),
    passable: run.mask.slice(),
    agents,
    jobs,
    findings: report.findings,
    truth,
    rasters,
    report,
  }
}

/** Indices of cells the viewer should draw as structure. */
export function structureIndices(frame: SimFrame): Uint32Array {
  const out: number[] = []
  for (let i = 0; i < frame.cellState.length; i++) {
    const s = frame.cellState[i]!
    if (s === CELL_OCCUPIED || s === CELL_BLOCKED) out.push(i)
  }
  return Uint32Array.from(out)
}

/** How well a cell has been seen, 0..1, for shading. */
export function observationRatio(frame: SimFrame, index: number, saturateAt = 3): number {
  const n = frame.observed[index] ?? 0
  if (n === 0) return 0
  return Math.min(1, n / saturateAt)
}

/** Candidate count, before association — for the viewer's raw-vs-reported readout. */
export function rawCandidateCount(run: SimRun): number {
  return run.candidates.length
}

/** Findings after report-level association, which is what the marker layer draws. */
export function associatedFindingCount(run: SimRun): number {
  return associateCandidates(run.candidates).findings.length
}