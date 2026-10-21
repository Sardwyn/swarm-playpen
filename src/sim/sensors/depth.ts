/**
 * Depth sensor observation model. Spec §4.1.
 *
 * Not a rasteriser. A fan of 2-D rays cast against the passability mask, with
 * the range noise, dropout and outlier terms applied per ray. Depth is the load-
 * bearing sensor in v1 precisely because RGB is deferred (spec §4.6) — every
 * capability under test is provable from depth plus scalar fields.
 */

import type { AgentId, DepthPoint, DepthScan } from '../types.ts'
import type { Grid } from '../world/geometry.ts'
import { CELL, castRay, gridIndex, inBounds, markRayObservation, worldToCellX, worldToCellZ, DEPTH_RAYS } from '../world/geometry.ts'

export { DEPTH_RAYS }
import type { Rng } from '../rng.ts'
import { NOISE } from './noise.ts'
import { TWO_PI, cos, sin, sqrt } from '../math.ts'

/**
 * Mark the agent's own footprint as observed.
 *
 * Physically: the robot knows where it is standing (proprioception, footers,
 * wheel encoders) and can see the floor immediately around it. It does NOT need
 * a depth return to know the cell it occupies is navigable.
 *
 * Without this the robot can be sitting on an unobserved cell, pick it as a
 * frontier, judge itself already arrived (the cell is inside the waypoint
 * tolerance), and deadlock — replanning the same zero-distance goal forever with
 * the coverage figure frozen. That failure is invisible in a log full of
 * activity, which is what makes it worth a function.
 */
export function markFootprint(
  g: Grid,
  mask: Uint8Array,
  x: number,
  z: number,
  radiusM: number,
): number {
  const rCells = Math.ceil(radiusM / CELL)
  const cx = worldToCellX(g, x)
  const cz = worldToCellZ(g, z)
  const r2 = rCells * rCells
  let newly = 0
  for (let dz = -rCells; dz <= rCells; dz++) {
    for (let dx = -rCells; dx <= rCells; dx++) {
      if (dx * dx + dz * dz > r2) continue
      const nx = cx + dx
      const nz = cz + dz
      if (!inBounds(g, nx, nz)) continue
      const i = gridIndex(g, nx, nz)
      if (mask[i] !== 1) continue
      if (g.observedCount[i] === 0) newly++
      g.observedCount[i] = g.observedCount[i]! + 1
    }
  }
  return newly
}

/**
 * Simulate one depth scan.
 *
 * Returns the point set AND applies observation marks to the grid, because
 * coverage is a consequence of sensing rather than a separate bookkeeping step —
 * splitting them would let the two disagree, which is how a coverage metric
 * starts measuring something the robot never did.
 */
export function scanDepth(
  g: Grid,
  mask: Uint8Array,
  agentId: AgentId,
  tick: number,
  x: number,
  z: number,
  heading: number,
  range: number,
  rng: Rng,
  noiseMultiplier: number,
  /** Optional per-bearing range sink, reused by the thermal sensor. */
  rangeOut?: Float64Array,
): DepthScan {
  const points: DepthPoint[] = []
  let newlyObserved = markFootprint(g, mask, x, z, 0.2)

  // Spec §4.1: fixed budget via deterministic stride, so sensor cost does not
  // vary with scene density. A variable-length scan would make per-tick cost a
  // function of the house, and the tick budget in spec §9.6 would be fiction.
  const rayCount = Math.min(DEPTH_RAYS, NOISE.depthBudget)

  for (let i = 0; i < rayCount; i++) {
    // Rays span the full circle: a differential-drive bot sees sideways via its
    // depth camera even though it cannot drive sideways.
    const bearing = heading + (TWO_PI * i) / rayCount
    const dirX = cos(bearing)
    const dirZ = sin(bearing)

    const trueRange = castRay(g, mask, x, z, dirX, dirZ, range)

    // Spec §4.1: mark observed along the ray so coverage responds to traversal.
    newlyObserved += markRayObservation(g, mask, x, z, dirX, dirZ, trueRange)

    // Publish the true range per bearing so the thermal sensor can reuse it.
    // Stubbing this to a constant (as the first cut did) makes every thermal ray
    // march the full 3 m through walls, so it samples anomalies behind masonry
    // and localises them to the wall face instead of the defect.
    if (rangeOut !== undefined) rangeOut[i] = trueRange

    // Axial sigma grows quadratically with range. At 4.5 m (hover range) that is
    // 0.044 m; at 0.4 m (inchworm) it is 0.0043 m. Realistic and, crucially,
    // it means a far sensor has worse localisation, which the allocator can see.
    const sigma = (NOISE.depthBaseSigma + NOISE.depthRangeSigma * trueRange * trueRange) * noiseMultiplier

    // Dropout: no return at all.
    if (rng.next() < NOISE.depthDropout * noiseMultiplier) continue

    let measured = trueRange
    let confidence = 1

    // Spec §4.1: rare multiplicative spike outliers at specular surfaces.
    if (rng.next() < NOISE.depthSpikeProbability * noiseMultiplier) {
      measured = trueRange * NOISE.depthSpikeFactor
      confidence = 0.15
    }

    if (sigma > 0) {
      measured += rng.normal(0, sigma)
      if (measured < 0) measured = 0
      if (measured > range) measured = range
      // Confidence falls off with range, so downstream fusion can weight it.
      confidence = Math.min(confidence, 1 - trueRange / (range * 1.5))
    }

    if (confidence < 0) confidence = 0

    points.push({
      x: x + dirX * measured,
      y: 0.2,
      z: z + dirZ * measured,
      confidence,
    })
  }

  void 0
  return { agentId, tick, points, valid: points.length > 0, newlyObserved }
}

/**
 * Mean confidence of a scan. Feeds `sensor.observation` in the log, which the
 * coverage and ATE metrics both read.
 */
export function scanConfidence(scan: DepthScan): number {
  if (scan.points.length === 0) return 0
  let sum = 0
  for (const p of scan.points) sum += p.confidence
  return sum / scan.points.length
}

/** Radial distance of the farthest confident return, for the viewer's range ring. */
export function scanExtent(scan: DepthScan): number {
  let max = 0
  for (const p of scan.points) {
    if (p.confidence < 0.3) continue
    const d = sqrt(p.x * p.x + p.z * p.z)
    if (d > max) max = d
  }
  return max
}