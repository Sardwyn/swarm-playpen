/**
 * Ceiling rastering. Spec §5.4 and the stage F gate "ceiling rasters at =0.6 confidence".
 * Stage F.
 *
 * ## What a ceiling raster can honestly claim
 *
 * The raster has **two layers with very different standing**, and keeping them apart is the
 * whole content of this module:
 *
 * - **Geometry — genuinely volumetric.** Each cell records the *altitude* the readings were
 *   taken from, and that comes from a 3-D raycast against real voxels (§11.31). A ground bot
 *   cannot produce this layer at all: it has no pose above 0.2 m and its 2-D grid has no
 *   height. This is the manifold's real contribution.
 * - **Temperature — not volumetric, and known not to be.** The scalar fields are
 *   ground-plane projections that ignore `y` (§11.28), so a thermal reading carries **no
 *   height information whatsoever**. An attic defect 3 m up is readable from the floor
 *   beneath it, measured: it moved the pinned reference run from 40 jobs to 45.
 *
 * So the raster is a *height-annotated* record of where the bot looked and what it read, and
 * it is explicitly **not** evidence that the hover bot can see things the ground bot
 * cannot. Writing it any other way would be the projection leak wearing a new hat.
 *
 * ## One number for the gate, and why it is one number
 *
 * `rasterConfidence` is `coveredFraction * meanCellConfidence`, in [0, 1]:
 *
 * - **coveredFraction** — cells with at least one observation over cells in the region. A
 *   raster with three observations over a thousand cells is not confident about the ceiling;
 *   it has three data points. Multiplying rather than averaging is deliberate: averaging
 *   would let three perfect cells out of a thousand report 1.0.
 * - **meanCellConfidence** — per cell, `observationQuality * agreement`. `observationQuality`
 *   saturates at `CEILING_REQUIRED_OBSERVATIONS` (2, matching the 2-D grid's
 *   `requiredObservation`: a cell glimpsed once in a doorway does not count, and the same
 *   reasoning applies here). `agreement` is 1 minus the spread of the readings normalised
 *   by `CEILING_SPREAD_TOLERANCE_K`.
 *
 * A disagreement between readings lowers confidence rather than being averaged away, which
 * is the same principle as §5.5's "disagreement is not averaged away, it is measured".
 */

import { clamp } from '../math.ts'

/** Spec's gate: "ceiling rasters at =0.6 confidence". */
export const CEILING_CONFIDENCE_GATE = 0.6

/**
 * Observations before a cell counts as surveyed.
 *
 * 2, for the same reason the 2-D grid uses 2: a single sample is a glimpse, and a glimpse is
 * what produced the "every wall at zero surface observations" and "2638 loop closures over
 * 25 m" results earlier in this project.
 */
export const CEILING_REQUIRED_OBSERVATIONS = 2

/**
 * Reading spread, in kelvin, at which agreement reaches zero.
 *
 * Chosen against the thermal sensor's own noise floor rather than picked for a round number:
 * `scanThermal` reports confidence from NETD and range, so two readings of the same surface
 * differing by more than this are not describing the same surface.
 */
export const CEILING_SPREAD_TOLERANCE_K = 2.0

export type CeilingCell = {
  /** How many readings have landed here. */
  observations: number
  /** Mean deviation from the ambient baseline, kelvin. */
  meanDeviationK: number
  /**
   * Mean altitude the readings were taken from, metres.
   *
   * Recorded because it is the only part of this raster that is genuinely volumetric, and
   * because it is what would become informative the moment the fields stop being
   * ground-plane projections.
   */
  meanAltitudeM: number
  /** Peak absolute deviation seen, kelvin. A hot spot that averages out should still show. */
  peakDeviationK: number
}

export type CeilingRaster = {
  readonly cellSizeM: number
  readonly minX: number
  readonly minZ: number
  readonly width: number
  readonly depth: number
  readonly cells: CeilingCell[]
}

export function rasterCellCount(raster: CeilingRaster): number {
  return raster.width * raster.depth
}

/**
 * An empty raster over a rectangular region on the ground plane.
 *
 * Region is a ground-plane rectangle even though the bot flies above it, because the cells
 * index *where the bot looked down at*, not where it was. A raster indexed by height would
 * need a 3-D structure to answer a question that is only ever asked per plan position.
 */
export function createCeilingRaster(
  minX: number,
  minZ: number,
  widthM: number,
  depthM: number,
  cellSizeM = 0.25,
): CeilingRaster {
  return {
    cellSizeM,
    minX,
    minZ,
    width: Math.max(1, Math.ceil(widthM / cellSizeM)),
    depth: Math.max(1, Math.ceil(depthM / cellSizeM)),
    cells: [],
  }
}

/**
 * Index of the cell containing a world position, or -1 if outside the rastered region.
 *
 * Exported because "what confidence does the cell I just looked at have" is a question the
 * report asks as well as the tests, and computing the index by hand in each place is how
 * two callers end up addressing different cells.
 */
export function rasterIndexAt(raster: CeilingRaster, x: number, z: number): number {
  return cellIndex(raster, x, z)
}

function cellIndex(raster: CeilingRaster, x: number, z: number): number {
  const cx = Math.floor((x - raster.minX) / raster.cellSizeM)
  const cz = Math.floor((z - raster.minZ) / raster.cellSizeM)
  if (cx < 0 || cx >= raster.width || cz < 0 || cz >= raster.depth) return -1
  return cx + raster.width * cz
}

/**
 * Record one reading.
 *
 * Returns false when the position is outside the rastered region, so a caller can tell "the
 * bot looked somewhere this raster does not cover" from "the bot looked here and the
 * reading was fine". Those are different, and collapsing them is how a partial raster ends
 * up reporting full coverage.
 */
export function observeCeiling(
  raster: CeilingRaster,
  x: number,
  z: number,
  altitudeM: number,
  deviationK: number,
): boolean {
  const i = cellIndex(raster, x, z)
  if (i < 0) return false

  const cell = raster.cells[i]
  if (cell === undefined) {
    raster.cells[i] = {
      observations: 1,
      meanDeviationK: deviationK,
      meanAltitudeM: altitudeM,
      peakDeviationK: Math.abs(deviationK),
    }
    return true
  }

  // Running means, recomputed from the count rather than accumulated, so a cell's value
  // does not depend on the order the readings arrived in.
  const n = cell.observations
  cell.meanDeviationK = (cell.meanDeviationK * n + deviationK) / (n + 1)
  cell.meanAltitudeM = (cell.meanAltitudeM * n + altitudeM) / (n + 1)
  cell.observations = n + 1
  const peak = Math.abs(deviationK)
  if (peak > cell.peakDeviationK) cell.peakDeviationK = peak
  return true
}

/** Per-cell confidence, 0..1. See the module header for the two terms. */
export function cellConfidence(raster: CeilingRaster, index: number): number {
  const cell = raster.cells[index]
  if (cell === undefined || cell.observations === 0) return 0

  const quality = Math.min(1, cell.observations / CEILING_REQUIRED_OBSERVATIONS)
  // With one observation there is no spread to measure, so agreement is undefined rather
  // than perfect. Treating a single reading as self-consistent is how a raster reports full
  // confidence from a single pass.
  if (cell.observations < 2) return quality * 0.5

  // Spread is estimated from the peak against the mean: the raster stores a running mean and
  // a peak rather than every sample, because the raster is read by the report and a
  // per-cell sample list would make it unbounded.
  const spread = Math.abs(cell.peakDeviationK - Math.abs(cell.meanDeviationK))
  const agreement = clamp(1 - spread / CEILING_SPREAD_TOLERANCE_K, 0, 1)
  return quality * agreement
}

/**
 * The gate's number, in [0, 1].
 *
 * Zero when the raster is empty, which is the honest answer rather than a vacuous 1.0 from a
 * mean over no cells.
 */
export function rasterConfidence(raster: CeilingRaster): number {
  const total = rasterCellCount(raster)
  if (total === 0) return 0

  let covered = 0
  let sum = 0
  for (let i = 0; i < total; i++) {
    const cell = raster.cells[i]
    if (cell === undefined || cell.observations === 0) continue
    covered++
    sum += cellConfidence(raster, i)
  }
  if (covered === 0) return 0
  return (covered / total) * (sum / covered)
}

/** Does this raster meet the stage F gate? */
export function meetsConfidenceGate(raster: CeilingRaster): boolean {
  return rasterConfidence(raster) >= CEILING_CONFIDENCE_GATE
}

/**
 * Summary for the report. The `thermalLayerIsVolumetric: false` is not decoration — it is
 * the finding from §11.28, carried into the output so no downstream reader can mistake a
 * height-annotated thermal raster for volumetric thermal sensing.
 */
export function summariseRaster(raster: CeilingRaster): {
  cells: number
  covered: number
  coveredFraction: number
  confidence: number
  gate: number
  meetsGate: boolean
  meanAltitudeM: number
  peakDeviationK: number
  thermalLayerIsVolumetric: false
  geometryLayerIsVolumetric: true
} {
  const total = rasterCellCount(raster)
  let covered = 0
  let altSum = 0
  let peak = 0
  for (const cell of raster.cells) {
    if (cell === undefined || cell.observations === 0) continue
    covered++
    altSum += cell.meanAltitudeM
    if (cell.peakDeviationK > peak) peak = cell.peakDeviationK
  }
  const confidence = rasterConfidence(raster)
  return {
    cells: total,
    covered,
    coveredFraction: total === 0 ? 0 : covered / total,
    confidence,
    gate: CEILING_CONFIDENCE_GATE,
    meetsGate: confidence >= CEILING_CONFIDENCE_GATE,
    meanAltitudeM: covered === 0 ? 0 : altSum / covered,
    peakDeviationK: peak,
    thermalLayerIsVolumetric: false,
    geometryLayerIsVolumetric: true,
  }
}