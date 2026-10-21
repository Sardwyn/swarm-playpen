/**
 * Humidity and air-quality sensors. Spec §4.3, §4.4.
 *
 * **Scalar only — no bearing.** A real humidity probe tells you the air is wet,
 * not where it is wet. That asymmetry against the thermal sensor is deliberate
 * and it has a consequence: moisture findings localise far worse than thermal
 * ones, and spec §9.2 says so ("a class detected reliably in the wrong place is a
 * different product"). The measured gap is the finding.
 *
 * Two error sources, and the second is the interesting one:
 *
 * - **Slow response.** First-order lag, τ = 4 s. A robot sweeping past a leak
 *   never sees the peak, only the tail.
 * - **Unknown calibration offset.** Per agent, constant for the run, not known
 *   to the agent. It forces the detector to work in *relative* rather than
 *   absolute terms, which is both why the confidence carries an interval and why
 *   the naive absolute detector is included as a control.
 */

import type { AgentId, HumidityReading } from '../types.ts'
import type { ScalarField } from '../world/fields.ts'
import { sampleField } from '../world/fields.ts'
import type { Rng } from '../rng.ts'
import { NOISE } from './noise.ts'
import { abs, clamp, exp } from '../math.ts'

/**
 * Per-agent humidity bias, deterministic on agent id.
 *
 * Unknown to the agent by construction — it cannot estimate what it cannot see.
 */
export function humidityBiasFor(agentId: string): number {
  return (hashUnit(agentId) - 0.5) * 2 * NOISE.humidityBias
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

/**
 * Mutable sensor state. A real sensor has memory; modelling it as a pure function
 * of position would delete the lag that makes the problem hard.
 *
 * Held per agent in the run, never in module scope — see ADR-001 §2.4.
 */
export type ScalarSensorState = {
  /** First-order lag state, in field units. */
  rhFiltered: number
  airFiltered: number
  initialised: boolean
}

export function createScalarState(): ScalarSensorState {
  return { rhFiltered: 0, airFiltered: 0, initialised: false }
}

export function readHumidity(
  field: ScalarField,
  agentId: AgentId,
  tick: number,
  x: number,
  z: number,
  dt: number,
  state: ScalarSensorState,
  rng: Rng,
  noiseMultiplier: number,
): { reading: HumidityReading; state: ScalarSensorState } {
  const truth = sampleField(field, x, z)

  // First-order lag: alpha = 1 - exp(-dt/tau). Uses our own exp.
  const alpha = 1 - exp(-dt / NOISE.humidityTau)

  const previous = state.initialised ? state.rhFiltered : truth
  const filtered = previous + (truth - previous) * alpha

  const bias = humidityBiasFor(agentId)
  let measured = filtered + bias
  if (noiseMultiplier > 0) {
    measured += rng.normal(0, 0.008 * noiseMultiplier)
  }
  measured = clamp(measured, 0, 1)

  // Confidence falls as the lag filters away a fast transient: the sensor is
  // reporting a value it cannot fully vouch for.
  const lagFraction = abs(truth - previous) / Math.max(abs(truth - field.baselineAt(x, z)), 1e-6)
  const confidence = clamp(1 - 0.4 * clamp(lagFraction, 0, 1), 0.1, 1)

  return {
    reading: { agentId, tick, rh: measured, confidence },
    state: { rhFiltered: filtered, airFiltered: state.airFiltered, initialised: true },
  }
}

export function readAir(
  field: ScalarField,
  agentId: AgentId,
  tick: number,
  x: number,
  z: number,
  dt: number,
  state: ScalarSensorState,
  rng: Rng,
  noiseMultiplier: number,
): { value: number; state: ScalarSensorState } {
  const truth = sampleField(field, x, z)
  const alpha = 1 - exp(-dt / (NOISE.humidityTau * 2))

  const previous = state.initialised ? state.airFiltered : truth
  const filtered = previous + (truth - previous) * alpha

  let value = filtered
  if (noiseMultiplier > 0) {
    value += rng.normal(0, 0.01 * noiseMultiplier)
  }
  void agentId
  void tick
  void x
  void z

  return {
    value: clamp(value, 0, 1),
    state: { rhFiltered: state.rhFiltered, airFiltered: filtered, initialised: true },
  }
}