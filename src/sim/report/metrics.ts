/**
 * Detection metrics. Spec §9.2.
 *
 * Scores candidates against the oracle. **This module is allowed to read the
 * answer key** — it is an evaluator, not part of the simulation, and the
 * distinction is enforced by the boundary test rather than by convention.
 *
 * Everything here is per class, and the per-class breakdown is not bookkeeping
 * detail: spec §9.2 exists because a single aggregate F1 over six classes hides
 * exactly the differences that matter. `clutter_hazard` and `structural_crack`
 * are known-pessimistic at Stage B (no vision, spec §4.6) and their numbers must
 * never be compared against a later stage's.
 */

import type { Anomaly, AnomalySet, AnomalyClass } from '../world/anomalies.ts'
import type { Candidate } from '../sim/detectors.ts'
import { sqrt, abs, max, min } from '../math.ts'

export type ClassMetrics = {
  readonly cls: string
  readonly truePositives: number
  readonly falsePositives: number
  readonly falseNegatives: number
  readonly precision: number
  readonly recall: number
  readonly f1: number
  /** Mean centroid distance of matched pairs, metres. Null when unmatched. */
  readonly meanLocalisationError: number | null
  readonly meanExtentIou: number | null
  /** True when the class could not be assessed at all. See §8.2 rule 2. */
  readonly notAssessable: boolean
  readonly notAssessableReason: string | null
}

export type DetectionMetrics = {
  readonly byClass: readonly ClassMetrics[]
  readonly totalTruePositives: number
  readonly totalFalsePositives: number
  readonly falsePositivesPerRun: number
  readonly detectorCounts: Readonly<Record<string, number>>
  /** Per-detector class breakdown, for the naive-vs-baseline comparison. */
  readonly byDetector: Readonly<Record<string, readonly ClassMetrics[]>>
}

export type ScoredMatch = {
  readonly candidate: Candidate
  readonly anomaly: Anomaly
  readonly distance: number
  readonly iou: number
}

/**
 * Candidate association — non-maximum suppression within a class.
 *
 * A persistent defect is reported once per *approach*, not once per defect. Drive
 * past a boiler from four directions and the thermal detector fires each time,
 * producing four candidates for one hot appliance. Measured, that was 34 thermal
 * "false positives" for 4 real defects, and precision 0.11 — which says nothing
 * useful about the detector.
 *
 * So candidates of one class within `radiusM` are merged into a single finding
 * whose position is the confidence-weighted centroid, taking the representative's
 * class, detector and identity. This is standard perception practice and it is
 * where it belongs: **the report layer, not the detector.** Detectors report what
 * they saw; the report decides what counts as one finding.
 *
 * Corroborating observations raise confidence, because multi-view confirmation is
 * real evidence and spec §7.1's confidence fusion depends on having more than one
 * observation to fuse. The boost is capped so a hundred views of one object cannot
 * manufacture certainty.
 */
export function associateCandidates(
  candidates: readonly Candidate[],
  radiusM = 1.0,
): { findings: Candidate[]; corroborations: Map<string, number> } {
  const byClass = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const list = byClass.get(c.predictedClass) ?? []
    list.push(c)
    byClass.set(c.predictedClass, list)
  }

  const findings: Candidate[] = []
  const corroborations = new Map<string, number>()

  // Deterministic order: by class, then by descending confidence, then id.
  for (const cls of [...byClass.keys()].sort()) {
    const group = [...(byClass.get(cls) ?? [])].sort((a, b) => {
      if (a.confidence !== b.confidence) return b.confidence - a.confidence
      return a.id < b.id ? -1 : 1
    })

    const taken = new Array(group.length).fill(false)

    for (let i = 0; i < group.length; i++) {
      if (taken[i]) continue
      const seed = group[i]!

      // The merge radius scales with the candidate's own extent. A fixed radius is
      // wrong for a field whose sources are broad: the authored thermal sources run
      // to sigma 1.3 m, so one physical defect spans more than a metre and a 1.0 m
      // radius split it into four findings — 16 "false positives" for 4 real
      // defects, and a precision of 0.20 that described the association rule rather
      // than the detector.
      const seedExtent = Math.max(seed.halfExtents[0], seed.halfExtents[2])
      const mergeRadius = Math.max(radiusM, seedExtent * 1.5)

      let sumW = seed.confidence
      let sx = seed.x * seed.confidence
      let sz = seed.z * seed.confidence
      let count = 1

      for (let j = i + 1; j < group.length; j++) {
        if (taken[j]) continue
        const other = group[j]!
        if (distance3(other.x, other.y, other.z, seed.x, seed.y, seed.z) > mergeRadius) continue
        taken[j] = true
        count++
        sumW += other.confidence
        sx += other.x * other.confidence
        sz += other.z * other.confidence
      }

      taken[i] = true
      corroborations.set(seed.id, count)

      // Boost from multiple views, capped: five views is strong corroboration,
      // fifty is the same object seen more slowly.
      const boost = 1 + Math.min(count - 1, 4) * 0.08
      findings.push({
        ...seed,
        x: sx / sumW,
        z: sz / sumW,
        confidence: Math.min(1, seed.confidence * boost),
      })
    }
  }

  return { findings, corroborations }
}

/**
 * Match candidates to anomalies by class, nearest-first within a class.
 *
 * Greedy nearest-match rather than Hungarian: with a handful of items per class
 * the difference is negligible, and greedy is deterministic by construction,
 * which Hungarian over an arbitrary solver order would not be.
 */
export function scoreDetections(
  rawCandidates: readonly Candidate[],
  truth: AnomalySet,
  restrictToManifold?: 'ground' | 'constrained' | 'volumetric',
  /**
   * Guards the per-detector breakdown, which is built by re-scoring each
   * detector's subset. Without the flag that recurses forever.
   */
  withDetectorBreakdown = true,
): { metrics: DetectionMetrics; matches: ScoredMatch[] } {
  const { findings } = associateCandidates(rawCandidates)

  const anomalies = restrictToManifold
    ? truth.anomalies.filter((a) => a.manifold === restrictToManifold)
    : truth.anomalies

  const matches: ScoredMatch[] = []
  const usedAnomalies = new Set<string>()

  const byClass = new Map<string, Anomaly[]>()
  for (const a of anomalies) {
    const list = byClass.get(a.class) ?? []
    list.push(a)
    byClass.set(a.class, list)
  }

  // Deterministic candidate order: by class, then id.
  const ordered = [...findings].sort((a, b) => {
    if (a.predictedClass !== b.predictedClass) return a.predictedClass < b.predictedClass ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  for (const candidate of ordered) {
    const pool = (byClass.get(candidate.predictedClass) ?? []).filter((a) => !usedAnomalies.has(a.id))
    if (pool.length === 0) continue

    // Nearest unmatched anomaly of the same class, but only within a plausible
    // radius. Without a gate, a detector that fires everywhere "matches"
    // everything and recall looks perfect while localisation is nonsense.
    let best: Anomaly | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const a of pool) {
      const d = distance3(candidate.x, candidate.y, candidate.z, a.position[0], a.position[1], a.position[2])
      if (d < bestDistance) {
        bestDistance = d
        best = a
      }
    }

    const maxMatchDistance = 3.0
    if (best === null || bestDistance > maxMatchDistance) continue

    usedAnomalies.add(best.id)
    matches.push({ candidate, anomaly: best, distance: bestDistance, iou: extentIou(candidate, best) })
  }

  // A candidate that matched nothing is a false positive.
  const matchedIds = new Set(matches.map((m) => m.candidate.id))
  const unmatchedCandidates = findings.filter((c) => !matchedIds.has(c.id))

  const classes = new Set<string>([...byClass.keys(), ...findings.map((c) => c.predictedClass)])
  const metrics: ClassMetrics[] = []
  for (const cls of [...classes].sort()) {
    const truthItems = byClass.get(cls) ?? []
    const classMatches = matches.filter((m) => m.candidate.predictedClass === cls)
    const classCandidates = findings.filter((c) => c.predictedClass === cls)
    const tp = classMatches.length
    const fp = classCandidates.length - tp
    const fn = truthItems.length - tp

    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

    const errors = classMatches.map((m) => m.distance)
    const ious = classMatches.map((m) => m.iou)

    metrics.push({
      cls,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision,
      recall,
      f1,
      meanLocalisationError: errors.length === 0 ? null : mean(errors),
      meanExtentIou: ious.length === 0 ? null : mean(ious),
      notAssessable: false,
      notAssessableReason: null,
    })
  }

  // Classify what could not be assessed at all: a class whose anomalies live on a
  // manifold no agent has entered is not "0 recall", it is "no evidence either
  // way". Reporting it as 0 would be a false negative claim, which spec §8.2
  // rule 2 forbids.
  const reachableClasses = new Set<string>(
    truth.anomalies.filter((a) => !restrictToManifold || a.manifold === restrictToManifold).map((a) => a.class as string),
  )
  const adjusted: ClassMetrics[] = metrics.map((m): ClassMetrics => {
    const truthCount = truth.anomalies.filter((a) => a.class === m.cls).length
    if (restrictToManifold && truthCount > 0 && reachableClasses.size > 0) {
      // Classes present in this manifold are assessable; classes with zero
      // anomalies here are not.
      const hereCount = anomalies.filter((a) => a.class === m.cls).length
      if (hereCount === 0 && truthCount > 0) {
        return {
          ...m,
          notAssessable: true,
          notAssessableReason:
            'all instances lie on a manifold no agent has entered; no evidence either way',
          precision: 0,
          recall: 0,
          f1: 0,
        }
      }
    }
    return m
  })

  const detectorCounts: Record<string, number> = {}
  for (const c of rawCandidates) {
    detectorCounts[c.detectorId] = (detectorCounts[c.detectorId] ?? 0) + 1
  }

  const detectorIds = [...new Set(rawCandidates.map((c) => c.detectorId))].sort()
  const byDetector: Record<string, readonly ClassMetrics[]> = {}
  if (withDetectorBreakdown) {
    for (const d of detectorIds) {
      const subset = rawCandidates.filter((c) => c.detectorId === d)
      // The flag is what stops this recursion: the inner call does not itself
      // build a breakdown.
      const sub = scoreDetections(subset, truth, restrictToManifold, false)
      byDetector[d] = sub.metrics.byClass
    }
  }

  return {
    metrics: {
      byClass: adjusted,
      totalTruePositives: matches.length,
      totalFalsePositives: unmatchedCandidates.length,
      falsePositivesPerRun: unmatchedCandidates.length,
      detectorCounts,
      byDetector,
    },
    matches,
  }
}

function distance3(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
): number {
  const dx = x1 - x2
  const dy = y1 - y2
  const dz = z1 - z2
  return sqrt(dx * dx + dy * dy + dz * dz)
}

/** Intersection over union of two axis-aligned boxes. */
export function extentIou(candidate: Candidate, anomaly: Anomaly): number {
  const cx = candidate.x
  const cy = candidate.y
  const cz = candidate.z
  const ce = candidate.halfExtents
  const ae = anomaly.halfExtents
  const ap = anomaly.position

  const interMinX = max(cx - ce[0], ap[0] - ae[0])
  const interMaxX = min(cx + ce[0], ap[0] + ae[0])
  const interMinY = max(cy - ce[1], ap[1] - ae[1])
  const interMaxY = min(cy + ce[1], ap[1] + ae[1])
  const interMinZ = max(cz - ce[2], ap[2] - ae[2])
  const interMaxZ = min(cz + ce[2], ap[2] + ae[2])

  const ix = max(0, interMaxX - interMinX)
  const iy = max(0, interMaxY - interMinY)
  const iz = max(0, interMaxZ - interMinZ)
  const intersection = ix * iy * iz

  const cVol = 8 * ce[0] * ce[1] * ce[2]
  const aVol = 8 * ae[0] * ae[1] * ae[2]
  const union = cVol + aVol - intersection

  return union <= 0 ? 0 : intersection / union
}

function mean(values: readonly number[]): number {
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

export { abs }
export type { AnomalyClass }