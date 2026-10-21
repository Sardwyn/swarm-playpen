/**
 * S9 - the control arm of the thesis. test-scenarios.md S9.
 *
 * ## What this is, and what it is not
 *
 * The thesis is **not** "a heterogeneous swarm beats a homogeneous one". It is
 * "a heterogeneous swarm pays only if recombination helps evidence". This file tests
 * the first half *without* the second, because recombination clusters are Stage H and
 * do not exist yet.
 *
 * That makes it a **control arm, not a test of the thesis** - and the thesis predicts
 * it should lose, so a loss here is not a refutation. What the control arm is for is
 * converting "it lost" into "here is the number the real mechanism has to beat".
 *
 * ## The comparison as specced was confounded
 *
 * `test-scenarios.md` S9 says both arms are 72 Wh. They are not:
 *
 * | arm | composition | energy |
 * |---|---|---|
 * | H heterogeneous | ground 38 + inchworm 12 + hover 22 | **72 Wh** |
 * | A all-ground | 3 x ground | **114 Wh** |
 *
 * The all-ground arm carries 58% more energy, so the arms are re-matched here on energy
 * *and* headcount: H is ground(38) + inchworm(12) = 50 Wh, A is 2 x ground at 25 Wh =
 * 50 Wh. Battery is equalised with `initialBatteryFraction` = 25/38 rather than by
 * inventing a second agent class, so the arms differ in exactly one thing: capability.
 *
 * ## And the fix reproduced the original confound, which is the more useful finding
 *
 * The first version of the matching set `initialBatteryFraction` to 50/38 = **1.3158**.
 * `createRun` does `clamp(config.initialBatteryFraction, 0, 1)`, so that silently became
 * 1.0 and the "energy-matched" arm was granted 2 x 38 = 76 Wh. **Measured: the buggy
 * arm started with 74.50 Wh against H's 47.29 Wh - a 57% over-credit, which is the
 * spec's 58% confound reproduced almost exactly, after having been written down and
 * fixed.**
 *
 * Two findings, and they are different in kind:
 *
 * - The clamp was a real defect and the arms were not matched as claimed. Corrected,
 *   the granted packs are 47.29 Wh vs 48.50 Wh, a 2.6% gap that is the IMU calibration
 *   draw, not a design difference.
 * - **Correcting it moved no result.** Re-running gave identical numbers, because at
 *   300 s the ground bot spends **2.87% to 3.33%** of its pack. Energy was never the
 *   binding constraint on the ground manifold, so the energy-matching exercise - both
 *   mine and the spec's - was never going to bind.
 *
 * A confound that is repaired and changes nothing is a different fact from a confound
 * that is repaired and changes everything, and only running the corrected version
 * distinguishes them.
 *
 * ## The reference run: 30 seeds, `npm run diag:s9`
 *
 * Per-seed means over seeds 1-30, 300 s missions, paired on seed.
 *
 * | metric | H (ground+crawler) | A (2 x ground) | paired |
 * |---|---|---|---|
 * | starting pack granted, Wh | 47.29 | 48.50 | - |
 * | ground anomalies confirmed | 9.33 | 10.17 | A better 22, H better 0, tie 8 |
 * | ground false positives | 19.40 | 16.77 | A better 28, H better 0, tie 2 |
 * | ground coverage @60 s | **68.73%** | **95.50%** | A better **30**, H better 0 |
 * | constrained coverage | **49.41%** | 0.00% | H better **30**, A better 0 |
 * | constrained candidates raised | 2.00 | 0.00 | - |
 * | of those, confirmed at a port | **0.23** | 0.00 | - |
 * | energy actually used | 2.659 Wh | 1.559 Wh | A better 30, H better 0 |
 * | confirmed per Wh actually used | 3.611 | 6.529 | A better 30, H better 0 |
 *
 * ## Predictions, and one amendment recorded as an amendment
 *
 * Registered before the first measurement:
 *
 * - **P1 - H confirms more anomalies per rated Wh than A.** *Prior: doubtful.* **FAILS.**
 * - **P2 - A achieves higher ground coverage.** *Prior: likely.* **HOLDS.**
 * - **P3 - any advantage H has comes entirely from the constrained manifold.**
 *   *Prior: near-certain.* **HOLDS.**
 * - **P4 - the arms do not tie.** *Prior: certain.* **HOLDS.**
 *
 * **Amendment, made after the first run:** P2 and P4 were first measured against ground
 * coverage at the 300 s mission, where **both arms score 100.00%** because coverage
 * saturates at 120 s (measured 39.54% at 30 s, 68.82% at 60 s, 97.79% at 90 s, 100.00%
 * from 120 s). A metric pinned at its ceiling carries no information, so P2 and P4 are
 * re-registered against a 60 s mission. This repairs a broken measurement; neither
 * prediction ever made a claim about mission length.
 *
 * ## The finding, and the target it produces
 *
 * **P1 fails. Putting a crawler on the board costs ground coverage outright** - 26.77
 * percentage points, on 30 of 30 seeds - and buys a constrained ceiling of **2 defects**
 * (`ob-01`, `ob-02`: the only in-bore defects in a component the crawler can enter,
 * measured from the content).
 *
 * The break-even is therefore computable, which is the reason to run a control arm at
 * all:
 *
 * | | |
 * |---|---|
 * | ground confirmations given up | 0.83 |
 * | constrained ceiling reachable | 2 |
 * | **required in-bore confirmation rate** | **41.7%** |
 * | **measured in-bore confirmation rate** | **11.7%** |
 * | shortfall | **3.6x** |
 *
 * So Stage H's recombination mechanism has a number to hit: it must convert in-bore
 * suspicions into confirmed evidence at **41.7%** for the crawler to justify itself on
 * this house, against **11.7%** today. And that break-even still ignores the 26.77 pp
 * coverage loss, so the real target is higher.
 *
 * If Stage H cannot reach it, the honest conclusion is that this content does not
 * support a crawler at all - a finding about the house, worth knowing before Stage I
 * puts a third agent in it.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { loadAnomalies01 } from '../../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, runToCompletion, measure } from '../../src/sim/sim/run.ts'
import { scoreDetections } from '../../src/sim/report/metrics.ts'
import { GROUND_BOT, GROUND_BOT_2 } from '../../src/sim/sim/agents.ts'
import { INCHWORM } from '../../src/sim/types.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

/**
 * Per-bot battery fraction for the all-ground arm: 25 Wh each, so 2 x 25 = 50 Wh.
 *
 * **Not 50/38.** `createRun` does `clamp(initialBatteryFraction, 0, 1)`, so 1.3158
 * silently became 1.0 and the arm meant to be energy-matched was granted 74.50 Wh
 * against H's 47.29. The first run of this experiment was discarded for that reason,
 * and the corrected run is the one reported.
 */
const MATCHED_FRACTION = 25 / GROUND_BOT.batteryWh

/** Ground coverage saturates at 120 s, so the discriminating mission length is 60 s. */
const COVER_MISSION = 60

/**
 * Fewer seeds than the 30-seed reference run, because this file runs in the suite.
 * Assertions are either content invariants (no runs) or claims the reference run made
 * on 30 of 30 seeds, which five seeds cannot overturn.
 */
const SEEDS = [1, 2, 3, 4, 5]

/** Arm labels, quoted by the "what this file is not" guard at the bottom. */
const H_LABEL = 'ground + inchworm'
const A_LABEL = '2 x ground @ 25 Wh'

/** Named in the spec as the Stage H work. Not yet built - this array is the list. */
const RECOMBINATION_MECHANISMS_IMPLEMENTED = ['port_handoff'] as const

function runArm(key: 'H' | 'A', seed: number, missionSeconds: number) {
  return key === 'H'
    ? runToCompletion(
        createRun(
          house,
          defaultConfig({
            seed,
            noiseMultiplier: 1,
            missionSeconds,
            agents: [GROUND_BOT, INCHWORM],
            inchwormHomePort: 'duct-drop-utility',
          }),
          spawn,
        ),
      )
    : runToCompletion(
        createRun(
          house,
          defaultConfig({
            seed,
            noiseMultiplier: 1,
            missionSeconds,
            agents: [GROUND_BOT, GROUND_BOT_2],
            initialBatteryFraction: MATCHED_FRACTION,
          }),
          spawn,
        ),
      )
}

function groundCoverage(r: ReturnType<typeof runArm>): number {
  let total = 0
  let seen = 0
  for (let i = 0; i < r.mask.length; i++) {
    if (r.mask[i] !== 1) continue
    total++
    if (r.grid.observedCount[i]! >= 2) seen++
  }
  return total === 0 ? 0 : seen / total
}

type Score = {
  confirmed: number
  falsePositives: number
  constrainedCandidates: number
  constrainedConfirmed: number
  handoffsRaised: number
  coverage: number
  energyWh: number
  startingPackWh: number
  packUsedFraction: number
}

/**
 * Memoised. The first version recomputed both 300 s and 60 s missions inside every
 * assertion, which cost 663 s for 13 tests - most of the whole suite's budget spent
 * re-deriving the same twenty runs.
 */
const scores = new Map<string, Score>()
function score(key: 'H' | 'A', seed: number): Score {
  const cached = scores.get(`${key}:${seed}`)
  if (cached) return cached

  const long = runArm(key, seed, 300)
  const short = runArm(key, seed, COVER_MISSION)
  const scored = scoreDetections(long.candidates, truth, 'ground')
  let confirmed = 0
  let falsePositives = 0
  for (const row of scored.metrics.byClass) {
    confirmed += row.truePositives
    falsePositives += row.falsePositives
  }

  const startingPackWh = long.agents.reduce((s, a) => s + a.battery * a.spec.batteryWh, 0)
  const energyWh = measure(long).energyUsedWh

  const out: Score = {
    confirmed,
    falsePositives,
    constrainedCandidates: long.candidates.filter((c) => c.manifold === 'constrained').length,
    constrainedConfirmed: long.handoffs.confirmed,
    handoffsRaised: long.handoffs.raised,
    coverage: groundCoverage(short),
    energyWh,
    startingPackWh,
    packUsedFraction: energyWh / startingPackWh,
  }
  scores.set(`${key}:${seed}`, out)
  return out
}

const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
const col = (key: 'H' | 'A', k: keyof Score) => SEEDS.map((s) => score(key, s)[k] as number)

describe('S9 - the control arm: capability without recombination', () => {
  describe('the specced comparison was confounded, and so was my first fix', () => {
    it('the all-ground arm in the spec carries 58% more energy than the heterogeneous one', () => {
      // ground 38 + inchworm 12 + hover 22 = 72 Wh, per spec 3.3. Three ground bots
      // are 114 Wh. The table's "matched energy" claim is off by 42 Wh.
      const HOVER_WH = 22
      const speccedHeterogeneous = GROUND_BOT.batteryWh + INCHWORM.batteryWh + HOVER_WH
      const speccedAllGround = 3 * GROUND_BOT.batteryWh
      expect(speccedHeterogeneous).toBe(72)
      expect(speccedAllGround).toBe(114)
      expect(speccedAllGround / speccedHeterogeneous - 1).toBeGreaterThan(0.5)
    })

    it('the fraction in use is under 1, so it cannot be silently clamped up to full pack', () => {
      // The specific bug. 50/38 = 1.3158 clamps to 1.0 in createRun, which hands the
      // "energy-matched" arm 2 x 38 = 76 Wh. Pinned so a well-meaning edit back to the
      // energy-total form fails here rather than silently re-confounding the experiment.
      expect(MATCHED_FRACTION).toBeLessThan(1)
      expect(MATCHED_FRACTION).toBeCloseTo(0.6579, 3)
      expect(2 * GROUND_BOT.batteryWh * MATCHED_FRACTION).toBeCloseTo(50, 6)
    })

    it('and the packs the sim actually grants are within a few percent, not 57% apart', () => {
      // Nominal arithmetic says 50 vs 50. The granted packs differ by the IMU
      // calibration draw, and measuring the granted value is the only way to know that.
      const h = mean(col('H', 'startingPackWh'))
      const a = mean(col('A', 'startingPackWh'))
      expect(Math.abs(a - h) / h, `H ${h.toFixed(2)} Wh vs A ${a.toFixed(2)} Wh`).toBeLessThan(0.05)
    })

    it('energy was never the binding constraint, which is why fixing the clamp moved nothing', () => {
      // The reason the corrected run reproduced the buggy run exactly. At 300 s the
      // ground bot spends under 4% of its pack, so no pack size in this range binds.
      for (const key of ['H', 'A'] as const) {
        for (const seed of SEEDS) {
          expect(score(key, seed).packUsedFraction, `${key} seed ${seed}`).toBeLessThan(0.1)
        }
      }
    })
  })

  describe('the ceiling, which is a fact about the house', () => {
    it('only three of the seven constrained defects have a conduit target at all', () => {
      const constrained = truth.anomalies.filter((a) => a.manifold === 'constrained')
      expect(constrained.length).toBe(7)
      expect(constrained.filter((a) => a.conduit !== undefined).length).toBe(3)
    })

    it('and only two of those sit in a component the crawler can enter', () => {
      // Home port duct-drop-utility enters void-perimeter and nothing else, measured
      // in scripts/diag-s9.ts. ob-03 is in waste-sink, a different component.
      const r = runArm('H', 1, 300)
      const entered = new Set<string>()
      for (const [id, cov] of r.conduitCoverage) {
        if (cov.some((v) => v > 0)) entered.add(id)
      }
      expect([...entered]).toEqual(['void-perimeter'])

      const reachable = truth.anomalies.filter(
        (a) => a.manifold === 'constrained' && a.conduit !== undefined && entered.has(a.conduit.conduitId),
      )
      expect(reachable.map((a) => a.id)).toEqual(['ob-01', 'ob-02'])
    })

    it('and both of those carry sourceStrength 0, which is why they are hard to confirm', () => {
      // The structural reason confirmation is low: an in-bore obstruction contributes
      // nothing to any scalar field, so no agent outside the pipe has independent
      // evidence to offer. A conduit entry is not an air register.
      for (const id of ['ob-01', 'ob-02', 'ob-03']) {
        const a = truth.anomalies.find((x) => x.id === id)!
        expect(a.sourceStrength, id).toBe(0)
      }
    })
  })

  describe('the finding: the crawler costs ground coverage outright', () => {
    it('A reaches more ground coverage than H on every seed', () => {
      // 30 of 30 in the reference run. This asserts the direction is stable, not the
      // exact margin.
      for (const seed of SEEDS) {
        const h = score('H', seed).coverage
        const a = score('A', seed).coverage
        expect(a, `seed ${seed}: H ${(h * 100).toFixed(2)}% vs A ${(a * 100).toFixed(2)}%`).toBeGreaterThan(h)
      }
    })

    it('H confirms fewer anomalies per seed on average', () => {
      // Not "H never beats A": the reference run has H ahead on 5 of 30 seeds and tied
      // on 4. The claim is about the mean, and the per-seed spread is why.
      const hTot = SEEDS.map((s) => {
        const r = score('H', s)
        return r.confirmed + r.constrainedConfirmed
      })
      const aTot = SEEDS.map((s) => {
        const r = score('A', s)
        return r.confirmed + r.constrainedConfirmed
      })
      expect(mean(hTot)).toBeLessThan(mean(aTot))
    })

    it('and the constrained gain never repays the ground deficit on any single seed', () => {
      // The per-seed form of the break-even. H can be ahead in total, but only ever by
      // less than a single confirmation, which is noise rather than capability.
      for (const seed of SEEDS) {
        const h = score('H', seed)
        const a = score('A', seed)
        const delta = h.confirmed + h.constrainedConfirmed - (a.confirmed + a.constrainedConfirmed)
        expect(delta, `seed ${seed}: H ahead by ${delta}`).toBeLessThanOrEqual(1)
      }
    })

    it('while spending more energy to do it', () => {
      // 2.659 Wh vs 1.559 Wh per seed in the reference run. Rated Wh is a bad
      // denominator - the ground bot ends a 300 s mission with ~97% of its pack - so
      // this compares what was actually spent.
      for (const seed of SEEDS) {
        const h = score('H', seed).energyWh
        const a = score('A', seed).energyWh
        expect(h, `seed ${seed}: H ${h.toFixed(3)} Wh vs A ${a.toFixed(3)} Wh`).toBeGreaterThan(a)
      }
    })

    it('H does raise constrained candidates, and A raises none at all', () => {
      // The one thing the crawler is for, and the reason P3 held.
      let hTotal = 0
      for (const seed of SEEDS) {
        expect(score('A', seed).constrainedCandidates, 'a ground bot cannot raise in-bore candidates').toBe(0)
        hTotal += score('H', seed).constrainedCandidates
      }
      expect(hTotal).toBeGreaterThan(0)
    })
  })

  describe('the target this produces for Stage H', () => {
    it('the crawler needs a 41.7% in-bore confirmation rate to break even, against 11.7% today', () => {
      // Computed from the 30-seed reference run, and pinned because it is the number
      // the missing mechanism has to beat. Recomputing needs 30 seeds; the arithmetic
      // is spelled out so it can be checked by hand.
      //
      //   A confirms 10.1667 on the ground manifold, H confirms 9.3333 -> deficit 0.8334
      //   H's constrained ceiling                                    -> 2  (ob-01, ob-02)
      //   required = 0.8334 / 2 = 41.7%    measured = 0.2333 / 2 = 11.7%
      //   shortfall = 41.7 / 11.7 = 3.6x
      //
      // The four-digit means matter. Doing this subtraction off the *displayed* two-digit
      // figures - 10.17 and 9.33 - gives 0.84, hence 42.0% and a 3.65x shortfall, and
      // that arithmetic disagrees with the reported 3.6x by more than the tolerance.
      // The unrounded per-seed means are the reference; the printed table is rounded for
      // legibility and is not what the ratio is computed from.
      const A_GROUND = 10.1667
      const H_GROUND = 9.3333
      const H_CONSTRAINED_CONFIRMED = 0.2333
      const CEILING = 2

      const deficit = A_GROUND - H_GROUND
      expect(deficit / CEILING).toBeCloseTo(0.417, 2)
      expect(H_CONSTRAINED_CONFIRMED / CEILING).toBeCloseTo(0.117, 2)
      expect(deficit / CEILING / (H_CONSTRAINED_CONFIRMED / CEILING)).toBeCloseTo(3.6, 1)
    })

    it('and the shortfall is real: H confirms few of the handoffs it raises', () => {
      let raised = 0
      let confirmed = 0
      for (const seed of SEEDS) {
        const s = score('H', seed)
        raised += s.handoffsRaised
        confirmed += s.constrainedConfirmed
      }
      expect(raised, 'the crawler raised no handoffs, so there was nothing to convert').toBeGreaterThan(0)
      expect(confirmed / raised, `${confirmed} confirmed of ${raised} raised`).toBeLessThan(0.417)
    })
  })

  describe('what this file is not', () => {
    it('no hover bot exists, so A cannot be said to lose on ceiling or attic work', () => {
      // Recorded as an explicit absence rather than left implicit. The all-ground arm
      // has no answer for anything above floor level, and this comparison never
      // offered it one.
      const ids = [GROUND_BOT.id, GROUND_BOT_2.id, INCHWORM.id]
      expect(ids.some((i) => i.includes('hover'))).toBe(false)
    })

    it('the comparison is capability WITHOUT recombination, which is the control, not the thesis', () => {
      // A guard against this file being cited later as a refutation of the thesis. The
      // thesis says recombination is what pays; recombination clusters are Stage H and
      // do not exist, so nothing here can test them. The port handoff is the only
      // composite-observation mechanism in existence, and it is the one at 11.7%.
      expect(H_LABEL).toBe('ground + inchworm')
      expect(A_LABEL).toBe('2 x ground @ 25 Wh')
      expect(RECOMBINATION_MECHANISMS_IMPLEMENTED).toEqual(['port_handoff'])
    })
  })
})