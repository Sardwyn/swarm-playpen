/**
 * Recombination confidence fusion. Spec §7.1, §13.6.
 *
 * Tested against **synthetic composite observations**, not against agents. The
 * inchworm and hover bot do not physically exist until Stages E and F, and
 * putting stubs into the run would have been the faster path and a trap: a stub
 * that satisfies jobs it cannot really reach would inflate coverage, drive
 * allocation regret toward zero for the wrong reason, and hand Stage E a number it
 * could not reproduce.
 *
 * So the fusion maths is the thesis machinery and is tested now; the agents are
 * not, and faking them would put a false result into the one suite whose job is to
 * prevent exactly that.
 */

import { describe, expect, it } from 'vitest'
import {
  fuseObservations,
  naiveFusion,
  independenceFactor,
  isLoadBearing,
  classifyCluster,
  FUSION_CAP,
} from '../../src/sim/sim/cluster.ts'
import type { Observation, ClusterType } from '../../src/sim/sim/cluster.ts'

function obs(over: Partial<Observation> = {}): Observation {
  return {
    agentId: 'ground-01',
    class: 'ground',
    modality: 'thermal',
    confidence: 0.5,
    magnitude: 3,
    covarianceScale: 1,
    ...over,
  }
}

describe('spec §10 — naive fusion', () => {
  it('is 1 - Π(1 - c_i), capped', () => {
    // Two independent 0.5 observations: 1 - 0.5·0.5 = 0.75.
    expect(naiveFusion([obs({ confidence: 0.5 }), obs({ confidence: 0.5 })])).toBeCloseTo(0.75, 10)
  })

  it('caps at 0.95 rather than approaching certainty', () => {
    // Six certain observations would otherwise fuse to ~1.0 and the report would
    // claim certainty it has not earned. Spec §10 CONFIDENCE_FUSION cap.
    const six = Array.from({ length: 6 }, (_, i) => obs({ agentId: `a${i}`, confidence: 0.999 }))
    expect(naiveFusion(six)).toBe(FUSION_CAP)
  })

  it('one observation is not a composite', () => {
    expect(() => fuseObservations([obs()], 'capability')).toThrow(/at least two/)
  })
})

describe('spec §7.1 — the covariance discount, and why it is the important half', () => {
  it('two DIFFERENT modalities are treated as independent witnesses', () => {
    const r = fuseObservations(
      [obs({ modality: 'thermal' }), obs({ modality: 'humidity', agentId: 'inch-01', class: 'inchworm' })],
      'capability',
    )
    expect(r.fusedConfidence).toBeCloseTo(r.naiveConfidence, 10)
    expect(r.discountReason).toBe('')
    expect(r.confidenceDelta).toBeCloseTo(0, 10)
  })

  it('two of the SAME modality are not two witnesses', () => {
    // This is the whole point of the module. Two agents both reading the same warm
    // pipe through the same emissivity error are not independent evidence, and the
    // textbook rule would happily add their confidences.
    //
    // Two 0.8 readings fuse naively to 1 - 0.04 = 0.96, which the 0.95 cap trims.
    // Independence then halves for the repeat. The cap is applied *after* the
    // discount, so the fused value is 0.475 — not 0.95.
    const r = fuseObservations(
      [obs({ modality: 'thermal', confidence: 0.8 }), obs({ modality: 'thermal', agentId: 'hover-01', confidence: 0.8 })],
      'sensory',
    )
    expect(r.naiveConfidence).toBeCloseTo(FUSION_CAP, 10)
    expect(r.fusedConfidence).toBeCloseTo(FUSION_CAP * 0.5, 10)
    expect(r.confidenceDelta).toBeLessThan(0)
    expect(r.discountReason).toMatch(/share a modality/)
    expect(r.discountReason).toMatch(/not two witnesses/)
  })

  it('discounts scale with the number of repeats', () => {
    const two = independenceFactor([obs({ modality: 'thermal' }), obs({ modality: 'thermal' })])
    const three = independenceFactor([
      obs({ modality: 'thermal' }),
      obs({ modality: 'thermal' }),
      obs({ modality: 'thermal' }),
    ])
    expect(three.factor).toBeLessThan(two.factor)
    expect(two.factor).toBeCloseTo(0.5, 6)
    expect(three.factor).toBeCloseTo(0.25, 6)
  })

  it('applies a per-observation covariance scale on top of the modality discount', () => {
    // This is the Stage G case arriving early: an observation whose uncertainty was
    // inherited across a port handoff carries less weight than one measured
    // locally, and the fused number must say so.
    const r = fuseObservations(
      [
        obs({ modality: 'thermal', confidence: 0.7 }),
        obs({ modality: 'humidity', agentId: 'inch-01', confidence: 0.6, covarianceScale: 0.5 }),
      ],
      'capability',
    )
    const expected = naiveFusion([obs({ modality: 'thermal', confidence: 0.7 }), obs({ modality: 'humidity', confidence: 0.6 })])
    expect(r.fusedConfidence).toBeCloseTo(expected * 0.5, 10)
    expect(r.discountReason).toMatch(/covariance scale below 1/)
  })

  it('the cap is applied after the discount, not before', () => {
    // If the cap came first, a pair of near-certain repeats would pin at 0.95 and
    // then be halved to 0.475 — a different number entirely.
    const r = fuseObservations(
      [obs({ modality: 'thermal', confidence: 0.99 }), obs({ modality: 'thermal', confidence: 0.99 })],
      'sensory',
    )
    expect(r.naiveConfidence).toBe(FUSION_CAP)
    expect(r.fusedConfidence).toBeLessThan(r.naiveConfidence)
    expect(r.fusedConfidence).toBeLessThan(0.95)
  })

  it('a correlated pair never exceeds an independent pair of the same strengths', () => {
    const same = fuseObservations(
      [obs({ modality: 'thermal', confidence: 0.6 }), obs({ modality: 'thermal', confidence: 0.6 })],
      'sensory',
    )
    const different = fuseObservations(
      [obs({ modality: 'thermal', confidence: 0.6 }), obs({ modality: 'humidity', confidence: 0.6 })],
      'capability',
    )
    expect(same.fusedConfidence).toBeLessThan(different.fusedConfidence)
  })
})

describe('spec §9.4 — is the composite load-bearing?', () => {
  it('is load-bearing when the best single observation is below the threshold', () => {
    // The recombination case the thesis depends on: no single agent could confirm
    // it, and the pair could.
    expect(isLoadBearing([obs({ confidence: 0.35 }), obs({ modality: 'humidity', confidence: 0.4 })], 0.6)).toBe(true)
  })

  it('is NOT load-bearing when one agent already clears the threshold', () => {
    // Worth recording, but it is not evidence that recombination pays for a
    // heterogeneous swarm. Spec §9.4's criterion, and the reason S9 counts only
    // load-bearing clusters.
    expect(isLoadBearing([obs({ confidence: 0.75 }), obs({ modality: 'humidity', confidence: 0.3 })], 0.6)).toBe(false)
  })

  it('needs two members to be a composite at all', () => {
    expect(isLoadBearing([obs({ confidence: 0.1 })], 0.6)).toBe(false)
  })
})

describe('spec §7.1 — cluster typing', () => {
  it('same class is a sensory cluster', () => {
    expect(classifyCluster(['ground', 'ground'])).toBe<ClusterType>('sensory')
  })

  it('different classes is a capability cluster', () => {
    expect(classifyCluster(['ground', 'hover'])).toBe<ClusterType>('capability')
  })
})

describe('the thesis metric has a sign we can predict', () => {
  it('a heterogeneous pair beats a homogeneous pair of the same confidences', () => {
    // §0's claim, stated as an arithmetic identity rather than a hope: spending the
    // same two observations on two *different* sensors buys more than spending them
    // on two of the same. That is the entire argument for a heterogeneous swarm,
    // and it holds before a single robot exists.
    const homogeneous = fuseObservations(
      [obs({ modality: 'thermal', confidence: 0.55 }), obs({ modality: 'thermal', confidence: 0.55 })],
      'sensory',
    )
    const heterogeneous = fuseObservations(
      [obs({ modality: 'thermal', confidence: 0.55 }), obs({ modality: 'humidity', confidence: 0.55 })],
      'capability',
    )
    expect(heterogeneous.fusedConfidence).toBeGreaterThan(homogeneous.fusedConfidence)
  })

  it('the confidence delta is zero when no discount applies and negative when one does', () => {
    // Worth being precise about what `confidenceDelta` means, because it is easy to
    // read as "how much did recombination add". It does not: it is
    // `fused − naive`, i.e. **what the covariance discount took away**. A
    // heterogeneous pair has nothing to discount and so a delta of exactly zero;
    // a homogeneous pair is penalised. §9.4's recombination measurement is a
    // different quantity — the delta against *no cluster at all* — and is computed
    // by `isLoadBearing`.
    const heterogeneous = fuseObservations(
      [obs({ modality: 'thermal', confidence: 0.55 }), obs({ modality: 'humidity', confidence: 0.55 })],
      'capability',
    )
    const homogeneous = fuseObservations(
      [obs({ modality: 'thermal', confidence: 0.55 }), obs({ modality: 'thermal', confidence: 0.55 })],
      'sensory',
    )
    expect(heterogeneous.confidenceDelta).toBeCloseTo(0, 10)
    expect(homogeneous.confidenceDelta).toBeLessThan(0)
  })

  it('so a heterogeneous swarm can confirm something no homogeneous pair can', () => {
    // Neither single observation clears 0.6. The heterogeneous pair does; the
    // homogeneous pair does not. This is the §0 thesis as a unit test.
    const single = 0.55
    const homogeneous = fuseObservations(
      [obs({ modality: 'thermal', confidence: single }), obs({ modality: 'thermal', confidence: single })],
      'sensory',
    )
    const heterogeneous = fuseObservations(
      [obs({ modality: 'thermal', confidence: single }), obs({ modality: 'humidity', confidence: single })],
      'capability',
    )
    expect(homogeneous.fusedConfidence).toBeLessThan(0.6)
    expect(heterogeneous.fusedConfidence).toBeGreaterThan(0.6)
    expect(isLoadBearing([obs({ confidence: single }), obs({ modality: 'humidity', confidence: single })], 0.6)).toBe(
      true,
    )
  })
})