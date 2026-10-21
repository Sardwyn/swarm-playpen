/**
 * The hidden oracle. Spec §2.6.
 *
 * **This file is ground truth.** The sim reads it to build the scalar fields and
 * to score detections. No sensor, detector, allocator or agent may import it —
 * enforced by `test/boundary/no-ground-truth-leak.test.ts`.
 *
 * That separation is the whole reason the project exists. Detection accuracy is
 * only a number if the answer key is unreachable from the code doing the
 * guessing; otherwise it is a tautology, and the confidence scores are theatre.
 */

import type { Manifold } from '../types.ts'
import raw from '../../content/anomalies-01.json'

/** Spec §2.6. The six authored classes. */
export const ANOMALY_CLASSES = [
  'moisture_leak',
  'thermal_anomaly',
  'structural_crack',
  'blocked_vent',
  'clutter_hazard',
  'pest_indicator',
] as const

export type AnomalyClass = (typeof ANOMALY_CLASSES)[number]

export type Anomaly = {
  readonly id: string
  readonly class: AnomalyClass
  readonly manifold: Manifold
  readonly position: readonly [number, number, number]
  readonly halfExtents: readonly [number, number, number]
  /** 0..1. */
  readonly severity: number
  readonly expectedDetector: string
  /**
   * Magnitude contributed to the scalar field. Thermal anomalies are a hot or
   * cold source; moisture anomalies are an RH source. `sign` distinguishes
   * above-baseline from below.
   */
  readonly sourceStrength: number
  readonly sourceSigma: number
  readonly sign: 1 | -1
  /**
   * Where in a conduit this defect sits, for constrained-manifold instances.
   *
   * The same authority `position` has on the ground manifold: a pipe defect is
   * addressed by (conduit, arc) because that is where it physically is, and a box
   * around a pipe is a different place from a box around the room containing it.
   * Stage E needed this for the handoff — the crawler detects an obstruction and
   * hands off at a *port*, so the coordinator has to know which conduit and how far
   * along it before it can route.
   *
   * `position` is still required, and still used to build the scalar fields, so a
   * constrained defect contributes to the world exactly as a ground one does.
   */
  readonly conduit?: { readonly conduitId: string; readonly arc: number }
}

export type AnomalySet = {
  readonly id: string
  readonly houseId: string
  /** Spec §10: COVERAGE_THRESHOLD. Below this, no negative claim may be emitted. */
  readonly coverageThreshold: number
  /** Spec §10: IOU_MATCH. */
  readonly iouMatch: number
  readonly anomalies: readonly Anomaly[]
}

function validateSet(rawSet: unknown): AnomalySet {
  if (typeof rawSet !== 'object' || rawSet === null) throw new Error('anomalies: expected an object')
  const s = rawSet as Record<string, unknown>
  if (!Array.isArray(s.anomalies)) throw new Error('anomalies: `anomalies` must be an array')
  if (!((s.coverageThreshold as number) > 0)) {
    throw new Error('anomalies: coverageThreshold must be positive')
  }

  const seen = new Set<string>()
  const anomalies = (s.anomalies as unknown[]).map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`anomalies[${i}]: expected an object`)
    const a = entry as Record<string, unknown>

    if (typeof a.id !== 'string' || a.id.length === 0) throw new Error(`anomalies[${i}]: needs an id`)
    if (seen.has(a.id as string)) {
      throw new Error(`anomalies[${i}]: duplicate id '${a.id as string}' — id-keyed matching would silently drop one`)
    }
    seen.add(a.id as string)

    const cls = a.class as AnomalyClass
    if (!ANOMALY_CLASSES.includes(cls)) {
      throw new Error(`anomalies/${a.id as string}: unknown class '${String(a.class)}'`)
    }

    const manifold = a.manifold as Manifold
    if (!['ground', 'constrained', 'volumetric'].includes(manifold)) {
      throw new Error(`anomalies/${a.id as string}: unknown manifold '${String(a.manifold)}'`)
    }

    for (const key of ['position', 'halfExtents'] as const) {
      const v = a[key]
      if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw new Error(`anomalies/${a.id as string}: ${key} must be three finite numbers`)
      }
    }
    if ((a.halfExtents as number[]).some((h) => h <= 0)) {
      throw new Error(`anomalies/${a.id as string}: halfExtents must all be positive`)
    }

    const severity = a.severity as number
    if (!(severity > 0 && severity <= 1)) {
      throw new Error(`anomalies/${a.id as string}: severity must be in (0, 1]`)
    }

    const sign = (a.sign ?? 1) as 1 | -1
    if (sign !== 1 && sign !== -1) {
      throw new Error(`anomalies/${a.id as string}: sign must be 1 or -1`)
    }

    // Conduit target. Validated rather than trusted, because a bad arc here is
    // invisible everywhere: the graph builds, the crawler routes, and the defect is
    // simply never within sensor range — which presents as a recall problem rather
    // than a content typo.
    let conduit: { conduitId: string; arc: number } | undefined
    const raw = a.conduit as Record<string, unknown> | undefined
    if (raw !== undefined && raw !== null) {
      const conduitId = raw.conduitId
      const arc = raw.arc
      if (typeof conduitId !== 'string' || conduitId.length === 0) {
        throw new Error(`anomalies/${a.id as string}: conduit needs a conduitId`)
      }
      if (typeof arc !== 'number' || !Number.isFinite(arc) || arc < 0) {
        throw new Error(`anomalies/${a.id as string}: conduit needs a finite non-negative arc`)
      }
      conduit = { conduitId, arc }
    }

    return {
      id: a.id as string,
      class: cls,
      manifold,
      position: a.position as [number, number, number],
      halfExtents: a.halfExtents as [number, number, number],
      severity,
      expectedDetector: (a.expectedDetector as string) ?? 'unassigned',
      sourceStrength: (a.sourceStrength as number) ?? 0,
      sourceSigma: (a.sourceSigma as number) ?? 0.5,
      sign,
      ...(conduit === undefined ? {} : { conduit }),
    }
  })

  return {
    id: (s.id as string) ?? 'anomalies',
    houseId: (s.houseId as string) ?? 'unknown',
    coverageThreshold: s.coverageThreshold as number,
    iouMatch: (s.iouMatch as number) ?? 0.3,
    anomalies,
  }
}

export function loadAnomalySet(rawSet: unknown = raw): AnomalySet {
  return validateSet(rawSet)
}

export function loadAnomalies01(): AnomalySet {
  return validateSet(raw as unknown)
}

/**
 * Anomalies a given agent class can reach at all, given the manifold it lives on.
 *
 * Used by the report to separate "not found" from "never could have looked".
 * Spec §8.2 rule 2 — the distinction the report must never blur.
 */
export function accessibleTo(set: AnomalySet, manifold: Manifold): Anomaly[] {
  return set.anomalies.filter((a) => a.manifold === manifold)
}