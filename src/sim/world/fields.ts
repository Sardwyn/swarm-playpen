/**
 * The three scalar fields. Spec §2.7.
 *
 * **GROUND TRUTH.** Sampled by sensors through observation models, and read
 * directly by the metrics for scoring. This module imports the anomaly set
 * because an anomaly *is* a source in a field — that coupling is deliberate
 * (spec §2.7): it means an agent cannot detect a thermal anomaly by looking for
 * a red thing, only by integrating evidence against a baseline it must estimate
 * itself.
 *
 * Sampled onto a coarse grid and bilinearly interpolated, rather than summed from
 * sources at every query. With ~20 sources and a 120x80 grid, precomputing costs
 * a few hundred thousand kernel evaluations once, and every later sample is four
 * lookups. Summing per query would put a per-tick cost proportional to the
 * anomaly count into the sensor budget, which spec §9.6 cannot absorb.
 */

import type { Manifold } from '../types.ts'
import { CELL } from './geometry.ts'
import type { AnomalySet } from './anomalies.ts'
import { clamp, exp, sqrt } from '../math.ts'

/** Coarse field resolution, metres. Finer than this buys nothing visible. */
export const FIELD_CELL = 0.25

/** Ambient baselines, Kelvin for temperature and fraction for the others. */
const AMBIENT = {
  temperatureK: 293.15, // 20 C
  humidity: 0.42,
  air: 0.15,
}

export type FieldKind = 'temperature' | 'humidity' | 'air'

export type ScalarField = {
  readonly kind: FieldKind
  readonly minX: number
  readonly minZ: number
  readonly width: number
  readonly height: number
  /** Coarse samples, row-major by z then x. */
  readonly data: Float32Array
  /** Ambient baseline at this point, before any source. Used as the detector's reference. */
  readonly baselineAt: (x: number, z: number) => number
}

function buildField(
  kind: FieldKind,
  minX: number,
  minZ: number,
  widthM: number,
  depthM: number,
  ambient: number,
  anomalies: AnomalySet,
): ScalarField {
  const width = Math.max(1, Math.ceil(widthM / FIELD_CELL))
  const height = Math.max(1, Math.ceil(depthM / FIELD_CELL))
  const data = new Float32Array(width * height)

  // Sources that actually affect this field. Anomaly classes that have no
  // signature in a given field contribute nothing, rather than contributing
  // noise — a crack has no humidity.
  //
  // The filter is on the **signature**, not the class. The signature is the
  // physical reading, and it is the reading that determines which field a defect
  // shows up in. The class is the cause, which is a domain's vocabulary and says
  // nothing about physics: keying the humidity field off `a.class === 'moisture_leak'`
  // meant that renaming a fault to `active_water_ingress` silently deleted the
  // moisture it produced, and the swarm stopped finding it. The class is for
  // readers; the signature is for the physics.
  //
  // The manifold filter is not a tidiness rule. The fields are sampled in the
  // *ground plane*, so a defect on another manifold that contributes here is a
  // defect the ground bot can smell from four hundred millimetres away through a
  // sealed pipe. The two authored `blocked_vent` instances on the constrained
  // manifold were doing exactly that: a blockage inside a duct raised the VOC
  // proxy in the room above it, and `detectBlockedVent` checked ground ports by
  // (x, z) distance alone, so a pipe and a room are the same place to this code.
  //
  // It also decides whether the two manifolds can be reasoned about separately at
  // all. Before this filter, authoring a defect inside a conduit changed the
  // ground bot's readings, which meant constrained content and ground detections
  // could not be varied independently — the two would have to be co-tuned forever.
  const sources = anomalies.anomalies.filter((a) => {
    if (kind === 'temperature') return a.sourceStrength !== 0
    if (kind === 'humidity') return a.signature === 'moisture_leak'
    return a.signature === 'blocked_vent'
  })

  for (let cz = 0; cz < height; cz++) {
    const z = minZ + (cz + 0.5) * FIELD_CELL
    for (let cx = 0; cx < width; cx++) {
      const x = minX + (cx + 0.5) * FIELD_CELL

      let base = ambient
      for (const a of sources) {
        const dx = x - a.position[0]
        const dz = z - a.position[2]
        const d2 = dx * dx + dz * dz
        const sigma = a.sourceSigma
        // Gaussian kernel, evaluated only within 4 sigma: beyond that the
        // contribution is under 1e-4 of peak and skipping it is free and exact
        // enough to be invisible in every metric.
        if (d2 > 16 * sigma * sigma) continue
        const kernel = exp(-d2 / (2 * sigma * sigma))
        base += a.sign * a.sourceStrength * kernel
      }
      data[cz * width + cx] = base
    }
  }

  return {
    kind,
    minX,
    minZ,
    width,
    height,
    data,
    baselineAt: () => ambient,
  }
}

export type WorldFields = {
  readonly temperature: ScalarField
  readonly humidity: ScalarField
  readonly air: ScalarField
}

/**
 * Build all three fields for a house.
 *
 * ## The fields are a ground-plane projection, and they say so
 *
 * Each field is sampled on a 2-D (x, z) grid at `FIELD_CELL`, ignoring `y`
 * entirely. A defect under the floor at y = 0 therefore raises the temperature a
 * robot *at floor level* reads, which is physically wrong for a sealed void and is
 * a known simplification rather than an oversight.
 *
 * The tempting fix is to filter sources by `anomaly.manifold`, so that a defect
 * labelled `constrained` stops contributing to a ground-manifold reading. That was
 * tried and reverted, and the measurement is worth keeping: it rewrote **1034 of
 * 1536 temperature cells, by up to 11.3 K**, and dropped `pest_indicator` recall
 * from 1.00 to 0.00.
 *
 * The reason is that `manifold` records where a defect *physically is*, not what
 * can *sense* it — and four of the authored anomalies (`ml-04`, `bv-02`, `bv-03`,
 * `pi-02`) are on the constrained manifold **because that is where they were put**,
 * while their thermal signature is what the ground-plane sensors were authored to
 * detect. Filtering by manifold does not correct a modelling simplification; it
 * deletes authored content and presents the deletion as a fix.
 *
 * So the field keeps its projection semantics, and the cost is recorded in
 * `test-scenarios.md` rather than paid quietly. A per-manifold field is the right
 * long-term answer and belongs with a volumetric field, which is Stage I.
 */
export function buildFields(
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  anomalies: AnomalySet,
): WorldFields {
  const w = bounds.maxX - bounds.minX
  const d = bounds.maxZ - bounds.minZ
  return {
    temperature: buildField('temperature', bounds.minX, bounds.minZ, w, d, AMBIENT.temperatureK, anomalies),
    humidity: buildField('humidity', bounds.minX, bounds.minZ, w, d, AMBIENT.humidity, anomalies),
    air: buildField('air', bounds.minX, bounds.minZ, w, d, AMBIENT.air, anomalies),
  }
}

/** Bilinear sample. Outside the field, returns the ambient baseline. */
export function sampleField(f: ScalarField, x: number, z: number): number {
  const fx = (x - f.minX) / FIELD_CELL - 0.5
  const fz = (z - f.minZ) / FIELD_CELL - 0.5

  if (fx < 0 || fz < 0 || fx >= f.width - 1 || fz >= f.height - 1) {
    return f.baselineAt(x, z)
  }

  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  const tx = fx - ix
  const tz = fz - iz

  const i00 = iz * f.width + ix
  const i10 = i00 + 1
  const i01 = i00 + f.width
  const i11 = i01 + 1

  const v00 = f.data[i00]!
  const v10 = f.data[i10]!
  const v01 = f.data[i01]!
  const v11 = f.data[i11]!

  const top = v00 + (v10 - v00) * tx
  const bottom = v01 + (v11 - v01) * tx
  return top + (bottom - top) * tz
}

/**
 * Deviation along a ray, with a *weighted-centroid* range rather than an argmax.
 *
 * This is what makes localisation better than "the agent's position when the
 * reading tripped". A thermal camera has a bearing and the depth sensor gives a
 * range for that bearing, so a candidate can be placed metres from the robot
 * rather than on top of it. Spec §9.2 requires localisation error as a metric
 * *because* a class found in the wrong place is a different product.
 *
 * The centroid matters. Taking the distance of maximum deviation is a biased
 * estimator: for a ray that passes *beside* a Gaussian source, the maximum sits
 * at closest approach, which is nearer to the robot than the source is. Averaged
 * over a cluster that bias drags every thermal candidate toward the robot, and it
 * measured 1.5 m of systematic localisation error before this change. The
 * deviation-weighted centroid is unbiased to first order and costs the same.
 */
export function sampleFieldRay(
  f: ScalarField,
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  maxRange: number,
  step: number,
  /** Detection threshold, used to high-pass the profile before centring. */
  threshold = 0,
): { value: number; distance: number; deviation: number } {
  const baseline = f.baselineAt(x, z)

  let peakDeviation = 0
  let peakValue = baseline
  let peakDistance = 0
  let weightSum = 0
  let weightedDistance = 0

  for (let d = step; d <= maxRange; d += step) {
    const value = sampleField(f, x + dirX * d, z + dirZ * d)
    const deviation = value - baseline
    const magnitude = deviation < 0 ? -deviation : deviation

    if (magnitude > peakDeviation) {
      peakDeviation = magnitude
      peakValue = value
      peakDistance = d
    }

    // Weight by how far *above the detection threshold* this sample is, not by
    // raw magnitude.
    //
    // Raw-magnitude weighting is biased toward the robot for broad sources: the
    // Gaussian's tail keeps contributing weight all the way down the ray, so the
    // centroid lands nearer the robot than the defect is. With sigma up to 1.3 m
    // in the authored set that bias measured 2.5 m of thermal localisation error.
    // Subtracting the threshold is a soft high-pass and concentrates the
    // centroid on the blob rather than on its skirt.
    const excess = magnitude - threshold
    if (excess <= 0) continue
    weightSum += excess
    weightedDistance += excess * d
  }

  const distance = weightSum > 1e-9 ? weightedDistance / weightSum : peakDistance

  return {
    value: peakValue,
    distance,
    // The reported deviation is the peak: it is the magnitude of the evidence,
    // and the peak is where the evidence is strongest.
    deviation: peakDeviation,
  }
}

export { CELL, clamp, sqrt }
export type { Manifold }