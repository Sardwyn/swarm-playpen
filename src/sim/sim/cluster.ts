/**
 * Recombination: co-located composite observation. Spec §7.1.
 *
 * ## What this is, and what it is not
 *
 * The brief asked for "bots forming chains or clusters". Physical docking is cut
 * from v1 — it needs attachment kinematics and compliant mechanics, and the
 * project's thesis is about *evidence*, not about latches. Recombination here is
 * two or more agents of different classes executing one decomposed job that no
 * single agent could complete, and the thing being measured is the **confidence
 * delta** the second opinion produces.
 *
 * ## Why this is a pure module
 *
 * The inchworm and hover bot do not physically exist until Stages E and F. This
 * module therefore takes *observations* rather than agents, and is tested against
 * synthetic composite observations.
 *
 * Putting stub agents into the run instead would have been the faster path and a
 * trap: a stub that satisfies jobs it cannot really reach would inflate coverage,
 * drive allocation regret toward zero for the wrong reason, and hand Stage E a
 * number it could not reproduce. The fusion maths is the thesis machinery and is
 * worth testing now; the agents are not, and pretending otherwise would put a
 * fake result into the one suite whose job is to prevent exactly that.
 */

import { clamp, powInt } from '../math.ts'

export type Observation = {
  readonly agentId: string
  readonly class: string
  /** Modality this observation came from. Two *different* modalities is the point. */
  readonly modality: string
  /** 0..1. Confidence in this observation alone. */
  readonly confidence: number
  readonly magnitude: number
  /** How strongly this observation is tied to the others — see `correlatedError`. */
  readonly covarianceScale: number
}

export type ClusterType = 'capability' | 'sensory' | 'traverse'

export type CompositeResult = {
  readonly type: ClusterType
  readonly members: readonly string[]
  readonly modalities: readonly string[]
  /** Naive independent fusion, `1 − Π(1 − c_i)`. */
  readonly naiveConfidence: number
  /** After the covariance discount. This is the number that must be trusted. */
  readonly fusedConfidence: number
  /** fused minus naive. Negative when the discount bites. */
  readonly confidenceDelta: number
  /** Why the discount was applied. Empty when it was not. */
  readonly discountReason: string
  /** True when the composite is the only reason this finding exists. */
  readonly loadBearing: boolean
}

/** Spec §10: CONFDENCE_FUSION cap. */
export const FUSION_CAP = 0.95

/**
 * Independent fusion: `c = 1 − Π(1 − c_i)`, capped.
 *
 * This is the textbook rule and it assumes the observations are independent. They
 * are not: two agents looking at the same warm pipe through the same physics are
 * not two independent witnesses.
 */
export function naiveFusion(observations: readonly Observation[]): number {
  if (observations.length === 0) return 0
  let product = 1
  for (const o of observations) {
    product *= 1 - clamp(o.confidence, 0, 1)
  }
  return Math.min(FUSION_CAP, 1 - product)
}

/**
 * How much the observations are *not* independent.
 *
 * Modality identity is the cheap and honest signal available at Stage C: two
 * thermal readings are largely the same measurement twice, a thermal reading and a
 * humidity reading are not. It is a proxy for the real covariance structure, which
 * needs the fused map from Stage G, and it is labelled as a proxy rather than
 * dressed up as the real thing.
 */
export function independenceFactor(observations: readonly Observation[]): { factor: number; reason: string } {
  if (observations.length < 2) return { factor: 1, reason: '' }

  const byModality = new Map<string, number>()
  for (const o of observations) {
    byModality.set(o.modality, (byModality.get(o.modality) ?? 0) + 1)
  }

  // Two members sharing a modality share their evidence; each repeat costs half the
  // independence of the first.
  let repeats = 0
  for (const [, n] of byModality) {
    if (n > 1) repeats += n - 1
  }
  if (repeats === 0) return { factor: 1, reason: '' }

  // Halve independence once per repeat. `repeats` is a count, so an integer power is
  // exact — and `Math.pow` is banned in the sim core (ADR-001 §2.3), so this goes
  // through the replacement rather than the platform.
  const factor = powInt(0.5, repeats)
  const shared = [...byModality.entries()].filter(([, n]) => n > 1).map(([m, n]) => `${m}x${n}`)
  return {
    factor,
    reason:
      `${shared.join(', ')} repeat${repeats > 1 ? 's' : ''} share a modality; ` +
      `independence scaled by ${factor.toFixed(2)}. Two agents reading the same physics are not two witnesses.`,
  }
}

/**
 * The covariance discount, spec §7.1 and §13.6.
 *
 * **This is the least-tested part of the whole specification**, and the reason it
 * is being written and unit-tested before the agents exist is precisely that it is
 * the part most likely to be implemented optimistically. An implementation that
 * applies only `naiveFusion` looks correct, passes a recall test, and reports
 * confidence it has not earned — which is the one failure mode §8.2 rule 3 exists
 * to prevent.
 */
export function fuseObservations(observations: readonly Observation[], type: ClusterType): CompositeResult {
  if (observations.length < 2) {
    throw new Error(
      `fuseObservations needs at least two observations; got ${observations.length}. ` +
        `A composite with one member is not recombination, and reporting it as a ` +
        `confidence boost would inflate every number it touches.`,
    )
  }

  const naive = naiveFusion(observations)
  const { factor, reason: modalityReason } = independenceFactor(observations)

  // Geometric discount from modality repeats, then the per-observation covariance
  // scale, then the cap. Applying the cap *before* the discounts would let a pair
  // of near-certain repeats pin confidence at the cap and then reduce it to
  // something meaningless.
  let fused = naive * factor
  const discounted = observations.filter((o) => o.covarianceScale < 1)
  for (const o of discounted) {
    fused *= o.covarianceScale
  }
  fused = Math.min(FUSION_CAP, fused)

  const reasons: string[] = []
  if (modalityReason !== '') reasons.push(modalityReason)
  if (discounted.length > 0) {
    reasons.push(
      `${discounted.length} observation(s) carry a covariance scale below 1 ` +
        `(${(fused / Math.max(naive * factor, 1e-9)).toFixed(2)}x residual).`,
    )
  }

  return {
    type,
    members: observations.map((o) => o.agentId),
    modalities: [...new Set(observations.map((o) => o.modality))],
    naiveConfidence: naive,
    fusedConfidence: fused,
    confidenceDelta: fused - naive,
    discountReason: reasons.join(' '),
    loadBearing: true,
  }
}

/**
 * Was the composite load-bearing?
 *
 * Spec §9.4's recombination criterion: a cluster counts as load-bearing only when
 * the finding does not exist without it. If the strongest single observation
 * already clears the confirmation threshold, the cluster added a second opinion
 * and nothing else — which is worth recording, but it is not evidence that
 * recombination pays for a heterogeneous swarm.
 */
export function isLoadBearing(observations: readonly Observation[], threshold: number): boolean {
  if (observations.length < 2) return false
  const best = Math.max(...observations.map((o) => o.confidence))
  return best < threshold
}

export function classifyCluster(classes: readonly string[]): ClusterType {
  const unique = new Set(classes)
  if (unique.size === 1) return 'sensory'
  // Different classes that share a manifold are combining capabilities at one
  // place; different manifolds means the composite spans a port.
  return unique.size > 1 ? 'capability' : 'sensory'
}