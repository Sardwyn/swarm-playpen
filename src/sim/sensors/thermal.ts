/**
 * Thermal sensor observation model. Spec §4.2.
 *
 * A fan of rays across the field of view; each returns the maximum deviation
 * along the ray plus the distance at which it occurs. The depth sensor supplies
 * the range for that bearing, which is how a candidate ends up metres from the
 * robot rather than on top of it.
 *
 * The error model is the interesting part. Emissivity error is the dominant
 * real-world thermal error — a 0.90-emissivity target read against a 0.95
 * surface reads ~4 K low — and it is a roughly constant per-agent offset. That is
 * what makes a naive absolute-threshold detector lose to a baseline-relative
 * one: the offset is indistinguishable from a real 4 K anomaly.
 */

import type { AgentId } from '../types.ts'
import type { ScalarField } from '../world/fields.ts'
import { sampleFieldRay } from '../world/fields.ts'
import type { Rng } from '../rng.ts'
import { NOISE } from './noise.ts'
import { TWO_PI, cos, sin, abs } from '../math.ts'

/** Field of view in radians. A wide-baseline thermal camera. */
export const FOV = 1.9

/** Ray count across the FOV. Fixed, so cost does not vary with the scene. */
export const THERMAL_RAYS = 48

export type ThermalRay = {
  readonly bearing: number
  /** Kelvin, with NETD noise and the agent's emissivity offset applied. */
  readonly temperature: number
  /** Metres, from the depth sensor's return on this bearing. */
  readonly range: number
  /** Deviation from the field's ambient baseline. */
  readonly deviation: number
  /** Falls off with range and with NETD magnitude. */
  readonly confidence: number
}

export type ThermalScan = {
  readonly agentId: AgentId
  readonly tick: number
  /**
   * Where the sensor was. Carried on the scan so a detector can place a
   * candidate at origin + offset without the caller having to pass the pose in
   * separately — and, more importantly, so the detector never has to
   * *reconstruct* the origin by algebra it cannot verify.
   */
  readonly originX: number
  readonly originZ: number
  readonly rays: readonly ThermalRay[]
  /**
   * This agent's emissivity offset in Kelvin. Constant for the run, which is
   * precisely why an absolute-threshold detector cannot see it as an artefact.
   */
  readonly emissivityOffset: number
  readonly valid: boolean
}

/**
 * Per-agent emissivity offset, drawn once at construction and never revisited.
 *
 * Deterministic per agent id rather than drawn from the shared stream, so it
 * cannot be perturbed by an unrelated call order — an error offset that shifted
 * with call order would make S3's per-agent results unstable for no reason.
 */
export function emissivityOffsetFor(agentId: string): number {
  // Sign and magnitude vary by agent; range chosen so the offset is comparable to
  // several authored anomalies, which is the point.
  const spread = NOISE.emissivityErrorK
  const h = hashUnit(agentId)
  const h2 = hashUnit(`${agentId}:salt`)
  return (h - 0.5) * 2 * spread * (0.5 + 0.5 * h2)
}

function hashUnit(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 2246822507) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 3266489909) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export function scanThermal(
  field: ScalarField,
  agentId: AgentId,
  tick: number,
  x: number,
  z: number,
  heading: number,
  maxRange: number,
  rng: Rng,
  noiseMultiplier: number,
  /** Ranges from the depth scan, indexed by bearing. Reused rather than re-cast. */
  depthRangeAt: (bearing: number) => number,
  /** Detection threshold, so the range estimator can high-pass the profile. */
  thermalBaselineK = 2.5,
): ThermalScan {
  const offset = emissivityOffsetFor(agentId)
  const rays: ThermalRay[] = []

  // Spec §4.2: a 3x3 spatial blur. Thermal cameras genuinely lack sharpness, and
  // modelling it as a scan-line maximum rather than a blur understates the
  // difficulty of separating a small hot spot from a warm wall.
  const blurSigma = NOISE.thermalBlurRadius * FIELD_STEP

  for (let i = 0; i < THERMAL_RAYS; i++) {
    // Fan across the FOV, centred on the body axis.
    const bearing = heading + (FOV * (i + 0.5)) / THERMAL_RAYS - FOV / 2
    const dirX = cos(bearing)
    const dirZ = sin(bearing)

    const range = Math.min(depthRangeAt(bearing), maxRange)
    const hit = sampleFieldRay(field, x, z, dirX, dirZ, range, FIELD_STEP, thermalBaselineK)

    // 3-tap blur along the ray: the middle tap weighted, the neighbours at 1/4.
    // This is a stand-in for a 2-D PSF, which needs an image to be honest about.
    const raw = hit.value
    const blurred = blur3(field, x, z, dirX, dirZ, hit.distance)

    let temperature = blurred + offset
    if (noiseMultiplier > 0) {
      temperature += rng.normal(0, NOISE.thermalNetd * noiseMultiplier)
    }

    const baseline = field.baselineAt(x, z) + offset
    const deviation = temperature - baseline

    // Confidence falls with range (PSF blur widens) and with the emissivity
    // term, which no amount of averaging removes.
    const rangeFactor = 1 - hit.distance / (maxRange * 1.4)
    const confidence = clamp01(rangeFactor * (1 - abs(offset) / (NOISE.emissivityErrorK * 2.5)))

    rays.push({ bearing, temperature, range: hit.distance, deviation, confidence })
    void raw
    void blurSigma
  }

  return { agentId, tick, originX: x, originZ: z, rays, emissivityOffset: offset, valid: rays.length > 0 }
}

/** Three-tap blur along the ray at the sampled distance. */
function blur3(
  field: ScalarField,
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  distance: number,
): number {
  const centre = sampleFieldAt(field, x, z, dirX, dirZ, distance)
  const ahead = sampleFieldAt(field, x, z, dirX, dirZ, distance + FIELD_STEP)
  const behind = sampleFieldAt(field, x, z, dirX, dirZ, Math.max(0, distance - FIELD_STEP))
  return centre * 0.5 + (ahead + behind) * 0.25
}

const FIELD_STEP = 0.05

function sampleFieldAt(
  field: ScalarField,
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  distance: number,
): number {
  const fx = x + dirX * distance
  const fz = z + dirZ * distance
  // Inline bilinear via the module's sampler would be circular; re-derive it.
  const f = field
  const cx = (fx - f.minX) / 0.25 - 0.5
  const cz = (fz - f.minZ) / 0.25 - 0.5
  if (cx < 0 || cz < 0 || cx >= f.width - 1 || cz >= f.height - 1) return f.baselineAt(fx, fz)
  const ix = Math.floor(cx)
  const iz = Math.floor(cz)
  const tx = cx - ix
  const tz = cz - iz
  const i00 = iz * f.width + ix
  const v00 = f.data[i00]!
  const v10 = f.data[i00 + 1]!
  const v01 = f.data[i00 + f.width]!
  const v11 = f.data[i00 + f.width + 1]!
  const top = v00 + (v10 - v00) * tx
  const bottom = v01 + (v11 - v01) * tx
  return top + (bottom - top) * tz
}

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

export { TWO_PI }