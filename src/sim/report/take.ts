/**
 * A recorded run: the frames, in order, ready to play back.
 *
 * ## Why a take at all
 *
 * The simulator is deterministic, so a run can be replayed by re-running it. But
 * re-running to seek is O(n) per seek, and a demo that stutters when you drag the
 * scrubber is a demo nobody drags. A take is the run, recorded once, with the
 * coverage stored as deltas, and it plays back instantly and identically every
 * time.
 *
 * ## Why the coverage is delta-encoded
 *
 * The observation count per cell only ever goes up, so a frame only needs the
 * cells that changed. A 300-frame take of the yacht domain is a fraction of a
 * megabyte instead of tens of megabytes, which is the difference between shipping
 * it and not.
 *
 * ## The recorder runs during the simulation
 *
 * There is no way to reconstruct a mid-run frame from a finished one, because the
 * ground grid and the rasters have moved on. So the recorder is fed the live run
 * every N ticks, and it keeps what changed rather than what was true.
 *
 * ## What this is not
 *
 * It is not a compression format and it is not a file format. It is a structure
 * with a stable shape, so a take can be serialised later without the shape
 * changing. The one thing it must not do is lie: every frame in a take is a frame
 * the simulator actually produced, at a tick it actually reached, and the log hash
 * in the header is the hash of that run.
 */

import type { AgentFrame, JobFrame, RasterFrame, SimFrame, TruthFrame } from './frame.ts'
import type { Finding, InspectionReport } from './report.ts'
import type { AnomalySet } from '../world/anomalies.ts'
import { buildReport } from './report.ts'
import type { SimRun } from '../sim/run.ts'
import { coverage } from '../world/geometry.ts'

/** One recorded frame: what changed, and where everything was. */
export type TakeFrame = {
  readonly tick: number
  readonly simSeconds: number
  readonly agents: readonly AgentFrame[]
  readonly jobs: readonly JobFrame[]
  readonly findings: readonly Finding[]
  /** Ground-manifold cells whose observation count changed, and the new count. */
  readonly observedDeltas: readonly { readonly index: number; readonly value: number }[]
  /** Volumetric raster cells that changed, and their new state. */
  readonly rasterDeltas: readonly {
    readonly raster: number
    readonly cell: number
    readonly observations: number
    readonly meanDeviationK: number
  }[]
}

export type Take = {
  readonly contentId: string
  readonly seed: number
  readonly noiseMultiplier: number
  readonly missionSeconds: number
  /** The hash of the run's event log. Proves the take came from the run it claims. */
  readonly logHash: string
  readonly cellSize: number
  readonly gridWidth: number
  readonly gridHeight: number
  readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number }
  readonly cellState: Uint8Array
  readonly passable: Uint8Array
  /** Raster geometry, fixed for the run. */
  readonly rasterGeometry: readonly {
    readonly agentId: string
    readonly cellSizeM: number
    readonly minX: number
    readonly minZ: number
    readonly width: number
    readonly depth: number
  }[]
  readonly truth: readonly TruthFrame[]
  readonly frames: readonly TakeFrame[]
  /** The report for the run as a whole. The panel's summary numbers. */
  readonly report: InspectionReport
}

export type RecorderOptions = {
  /** The content id, for provenance. */
  readonly contentId: string
  /** The authored oracle, for the truth overlay. */
  readonly truth: AnomalySet
  /** Record every Nth tick. */
  readonly everyNTicks?: number
}

/**
 * Records a run as it happens.
 *
 * Fed the live run every N ticks. It keeps the per-frame agent, job and finding
 * records in full because they are small, and keeps only the *changes* to the two
 * coverage arrays, because they are not.
 */
export class TakeRecorder {
  private readonly options: RecorderOptions
  private readonly everyN: number
  private readonly frames: TakeFrame[] = []
  private previousObserved: Uint32Array | null = null
  private previousRasters: Uint16Array[] = []
  private lastTick = -1

  constructor(options: RecorderOptions) {
    this.options = options
    this.everyN = Math.max(1, options.everyNTicks ?? 10)
  }

  /** Call every tick; it decides for itself whether this one is worth keeping. */
  record(run: SimRun): void {
    if (run.tick % this.everyN !== 0) return
    if (run.tick === this.lastTick) return
    this.lastTick = run.tick

    const observed = run.grid.observedCount
    const observedDeltas: { index: number; value: number }[] = []
    if (this.previousObserved === null) {
      for (let i = 0; i < observed.length; i++) {
        if (observed[i]! > 0) observedDeltas.push({ index: i, value: observed[i]! })
      }
    } else {
      for (let i = 0; i < observed.length; i++) {
        const v = observed[i]!
        if (v !== this.previousObserved[i]) observedDeltas.push({ index: i, value: v })
      }
    }
    this.previousObserved = observed.slice()

    // Rasters: dense snapshots, diffed against the previous frame's.
    const rasterDeltas: {
      raster: number
      cell: number
      observations: number
      meanDeviationK: number
    }[] = []
    const currentRasters: Uint16Array[] = []
    let rasterIndex = 0
    for (const [, raster] of run.hoverRasters) {
      const dense = new Uint16Array(raster.width * raster.depth)
      for (let i = 0; i < raster.cells.length; i++) {
        const cell = raster.cells[i]
        if (cell === undefined) continue
        dense[i] = cell.observations
        const previous = this.previousRasters[rasterIndex]
        if (previous === undefined || previous[i] !== cell.observations) {
          rasterDeltas.push({
            raster: rasterIndex,
            cell: i,
            observations: cell.observations,
            meanDeviationK: cell.meanDeviationK,
          })
        }
      }
      currentRasters.push(dense)
      rasterIndex++
    }
    this.previousRasters = currentRasters

    this.frames.push({
      tick: run.tick,
      simSeconds: run.tick / 10,
      agents: agentsOf(run),
      jobs: jobsOf(run),
      findings: reportFindings(run),
      observedDeltas,
      rasterDeltas,
    })
  }

  /** Close the take. The run must be finished. */
  finish(run: SimRun, report: InspectionReport): Take {
    this.record(run)

    const rasters: RasterFrame[] = []
    let i = 0
    for (const [agentId, raster] of run.hoverRasters) {
      const observations = new Uint16Array(raster.width * raster.depth)
      const meanDeviationK = new Float32Array(raster.width * raster.depth)
      for (let c = 0; c < raster.cells.length; c++) {
        const cell = raster.cells[c]
        if (cell === undefined) continue
        observations[c] = cell.observations
        meanDeviationK[c] = cell.meanDeviationK
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
      i++
    }

    return {
      contentId: this.options.contentId,
      seed: 0,
      noiseMultiplier: 0,
      missionSeconds: 0,
      logHash: run.log.hash(),
      cellSize: 0.05,
      gridWidth: run.grid.width,
      gridHeight: run.grid.height,
      bounds: {
        minX: run.house.bounds.minX,
        minZ: run.house.bounds.minZ,
        maxX: run.house.bounds.maxX,
        maxZ: run.house.bounds.maxZ,
      },
      cellState: run.grid.cells.slice(),
      passable: run.mask.slice(),
      rasterGeometry: rasters.map((r) => ({
        agentId: r.agentId,
        cellSizeM: r.cellSizeM,
        minX: r.minX,
        minZ: r.minZ,
        width: r.width,
        depth: r.depth,
      })),
      truth: this.options.truth.anomalies.map((a) => ({
        x: a.position[0],
        y: a.position[1],
        z: a.position[2],
        cls: a.class,
        severity: a.severity,
        manifold: a.manifold,
      })),
      frames: this.frames,
      report,
    }
  }
}

/**
 * The findings at the run's current state.
 *
 * Built through `buildReport` rather than `associateCandidates`, because the
 * report's findings carry the matched anomaly, the localisation error and the
 * status, and those are what a viewer draws and what a report quotes. The
 * association on its own is a list of candidates.
 */
function reportFindings(run: SimRun): Finding[] {
  const cov = coverage(run.grid, run.mask, 2)
  const report = buildReport({
    runId: `frame-${run.tick}`,
    tick: run.tick,
    simSeconds: run.tick / 10,
    candidates: run.candidates,
    truth: run.truth,
    rooms: run.house.rooms,
    coverage: [
      {
        manifold: 'ground',
        fraction: cov.observedFraction,
        observedCells: cov.observedCells,
        totalCells: cov.totalCells,
      },
    ],
    regionCoverage: [],
  })
  return report.findings.slice()
}

function agentsOf(run: SimRun): AgentFrame[] {
  return run.agents.map((a) => {
    const job = a.currentJobId === null ? undefined : run.jobs.get(a.currentJobId)
    const p = a.pose as { x?: number; z?: number; y?: number; theta?: number }
    return {
      id: a.spec.id,
      cls: a.spec.cls,
      x: p.x ?? 0,
      y: p.y ?? 0,
      z: p.z ?? 0,
      heading: p.theta ?? 0,
      battery: a.battery,
      currentJobId: a.currentJobId,
      currentJobType: job?.job.type ?? null,
      faulted: a.faulted,
    }
  })
}

function jobsOf(run: SimRun): JobFrame[] {
  return [...run.jobs.values()].map((record) => ({
    id: record.job.id,
    type: record.job.type,
    state: record.job.state,
    x: (record.job.region.minX + record.job.region.maxX) / 2,
    z: (record.job.region.minZ + record.job.region.maxZ) / 2,
    awardedTo: record.awardedTo,
    priority: record.job.priority,
  }))
}

/**
 * Rebuild the frame at an index in the take.
 *
 * The coverage arrays are rebuilt forward from the deltas, so the frame at index N
 * is the coverage as it stood at that tick — not the final coverage with the
 * agents from an earlier tick, which is the kind of mismatch that makes a demo
 * look like it is working when it is not.
 */
export function frameFromTake(take: Take, index: number): SimFrame {
  const clamped = Math.max(0, Math.min(take.frames.length - 1, index))
  const observed = new Uint32Array(take.gridWidth * take.gridHeight)
  const rasters: RasterFrame[] = take.rasterGeometry.map((g) => ({
    ...g,
    observations: new Uint16Array(g.width * g.depth),
    meanDeviationK: new Float32Array(g.width * g.depth),
  }))

  for (let f = 0; f <= clamped; f++) {
    const frame = take.frames[f]!
    for (const d of frame.observedDeltas) observed[d.index] = d.value
    for (const d of frame.rasterDeltas) {
      const r = rasters[d.raster]
      if (r === undefined) continue
      r.observations[d.cell] = d.observations
      r.meanDeviationK[d.cell] = d.meanDeviationK
    }
  }

  const frame = take.frames[clamped]!
  return {
    tick: frame.tick,
    simSeconds: frame.simSeconds,
    bounds: take.bounds,
    cellSize: take.cellSize,
    gridWidth: take.gridWidth,
    gridHeight: take.gridHeight,
    cellState: take.cellState,
    observed,
    passable: take.passable,
    agents: frame.agents,
    jobs: frame.jobs,
    findings: frame.findings,
    truth: take.truth,
    rasters,
    report: take.report,
  }
}

/** How much of the run's coverage has been examined, at a frame. */
export function observedFraction(take: Take, index: number): number {
  const frame = frameFromTake(take, index)
  let observed = 0
  let free = 0
  for (let i = 0; i < frame.observed.length; i++) {
    if (frame.passable[i] !== 1) continue
    free++
    if (frame.observed[i]! >= 2) observed++
  }
  return free === 0 ? 0 : observed / free
}

/**
 * The coverage of one region, at a frame.
 *
 * The global figure puts every region at the same number, and the withheld-claims
 * rule exists to stop exactly that: a survey that says "12% covered" without saying
 * *what* it covered is the failure this whole project is about.
 */
export function regionCoverage(
  take: Take,
  index: number,
  aabb: { minX: number; minZ: number; maxX: number; maxZ: number },
): number {
  const frame = frameFromTake(take, index)
  const cx0 = Math.floor((aabb.minX - frame.bounds.minX) / frame.cellSize)
  const cx1 = Math.floor((aabb.maxX - frame.bounds.minX) / frame.cellSize)
  const cz0 = Math.floor((aabb.minZ - frame.bounds.minZ) / frame.cellSize)
  const cz1 = Math.floor((aabb.maxZ - frame.bounds.minZ) / frame.cellSize)
  let total = 0
  let observed = 0
  for (let cz = Math.max(0, cz0); cz <= Math.min(frame.gridHeight - 1, cz1); cz++) {
    for (let cx = Math.max(0, cx0); cx <= Math.min(frame.gridWidth - 1, cx1); cx++) {
      const i = cz * frame.gridWidth + cx
      if (frame.passable[i] !== 1) continue
      total++
      if (frame.observed[i]! >= 2) observed++
    }
  }
  return total === 0 ? 0 : observed / total
}

/** The coverage of the run as a whole, for the panel's headline number. */
export function finalCoverage(run: SimRun): number {
  return coverage(run.grid, run.mask, 2).observedFraction
}
