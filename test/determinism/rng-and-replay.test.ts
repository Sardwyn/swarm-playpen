/**
 * Determinism. ADR-001 §1.4 and §2.4.
 *
 * The guarantee: same seed + same input stream => bit-identical state at tick N.
 * These tests also check the things that would make that guarantee *false while
 * appearing true*, which is the real risk.
 */

import { describe, expect, it } from 'vitest'
import { Rng } from '../../src/sim/rng.ts'
import { EventLog } from '../../src/sim/eventlog.ts'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { createRun, defaultConfig, measure, runToCompletion } from '../../src/sim/sim/run.ts'
import { scoreDetections } from '../../src/sim/report/metrics.ts'
import { loadAnomalies01 } from '../../src/sim/world/anomalies.ts'

describe('Rng', () => {
  it('produces an identical stream for the same seed', () => {
    const a = new Rng(4208)
    const b = new Rng(4208)
    for (let i = 0; i < 10_000; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  it('produces different streams for different seeds', () => {
    const a = new Rng(1)
    const b = new Rng(2)
    let same = 0
    for (let i = 0; i < 1000; i++) {
      if (a.next() === b.next()) same++
    }
    expect(same).toBeLessThan(5)
  })

  it('stays uniform in [0,1)', () => {
    const r = new Rng(7)
    const buckets = new Array(10).fill(0)
    for (let i = 0; i < 100_000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      buckets[Math.floor(v * 10)]++
    }
    for (const b of buckets) {
      expect(b).toBeGreaterThan(9000)
      expect(b).toBeLessThan(11_000)
    }
  })

  it('normal has the requested mean and sigma', () => {
    const r = new Rng(99)
    const samples: number[] = []
    for (let i = 0; i < 200_000; i++) samples.push(r.normal(3, 2))
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length
    const varc = samples.reduce((s, v) => s + (v - mean) * (v - mean), 0) / samples.length
    expect(Math.abs(mean - 3)).toBeLessThan(0.02)
    expect(Math.abs(Math.sqrt(varc) - 2)).toBeLessThan(0.02)
  })

  it('rejects a non-integer seed rather than rounding it silently', () => {
    expect(() => new Rng(1.5)).toThrow(/integer/)
  })

  it('rejects a fractional int bound rather than rounding it silently', () => {
    const r = new Rng(1)
    expect(() => r.int(4.5)).toThrow(/integer/)
    expect(() => r.int(0)).toThrow(/positive/)
  })

  it('snapshot and restore replay a stream exactly', () => {
    const r = new Rng(1234)
    for (let i = 0; i < 500; i++) r.next()
    const snap = r.snapshot()
    const forward = Array.from({ length: 100 }, () => r.next())

    const r2 = new Rng(1234)
    for (let i = 0; i < 500; i++) r2.next()
    r2.restore(snap)
    const replay = Array.from({ length: 100 }, () => r2.next())

    expect(replay).toEqual(forward)
  })
})

describe('EventLog', () => {
  it('rejects out-of-order events rather than silently reordering', () => {
    const log = new EventLog()
    log.push({ tick: 5, kind: 'run.started', data: {} })
    expect(() => log.push({ tick: 3, kind: 'run.started', data: {} })).toThrow(/out-of-order/)
  })

  it('hashes identically for identical content regardless of data key insertion order', () => {
    const a = new EventLog()
    a.push({ tick: 1, kind: 'sensor.observation', agentId: 'x', data: { confidence: 0.5, pointCount: 10 } })
    const b = new EventLog()
    // Same numbers, different insertion order — must still hash the same, because
    // object key order is an implementation detail and spec §1.4 forbids
    // depending on it.
    b.push({ tick: 1, kind: 'sensor.observation', agentId: 'x', data: { pointCount: 10, confidence: 0.5 } })
    expect(a.hash()).toBe(b.hash())
  })

  it('hash differs when any value differs', () => {
    const a = new EventLog()
    a.push({ tick: 1, kind: 'sensor.observation', agentId: 'x', data: { confidence: 0.5 } })
    const b = new EventLog()
    b.push({ tick: 1, kind: 'sensor.observation', agentId: 'x', data: { confidence: 0.5001 } })
    expect(a.hash()).not.toBe(b.hash())
  })
})

describe('run determinism', () => {
  const house = loadHouse01()
  const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

  it('two runs with the same seed produce the same log hash and metrics', () => {
    const cfg = defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 60 })

    const a = measure(runToCompletion(createRun(house, cfg, spawn)))
    const b = measure(runToCompletion(createRun(house, cfg, spawn)))

    expect(b.logHash).toBe(a.logHash)
    expect(b.coverageFraction).toBe(a.coverageFraction)
    expect(b.observedCells).toBe(a.observedCells)
    expect(b.energyUsedWh).toBe(a.energyUsedWh)
    expect(b.batteryRemaining).toEqual(a.batteryRemaining)
  })

  it('different seeds diverge', () => {
    const spawn2 = { x: -5.0, z: 0.0, theta: 0.0 }
    const a = measure(runToCompletion(createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 60 }), spawn2)))
    const b = measure(runToCompletion(createRun(house, defaultConfig({ seed: 2, noiseMultiplier: 1, missionSeconds: 60 }), spawn2)))
    expect(b.logHash).not.toBe(a.logHash)
  })

  it('is independent of the order agents are supplied in config', () => {
    // Spec §1.4: iterate by stable ID, never by position. If this fails, the run
    // order depends on how the config array happened to be built.
    const one = measure(runToCompletion(createRun(house, defaultConfig({ seed: 3, missionSeconds: 30 }), spawn)))
    const shuffled = [...defaultConfig({ seed: 3, missionSeconds: 30 }).agents].reverse()
    const two = measure(
      runToCompletion(createRun(house, defaultConfig({ seed: 3, missionSeconds: 30, agents: shuffled }), spawn)),
    )
    expect(two.logHash).toBe(one.logHash)
  })

  it('replaying the same seed in the same process is unaffected by a prior run', () => {
    // Module-level state would break this. It is the check that the run owns all
    // of its state.
    const cfg = defaultConfig({ seed: 77, noiseMultiplier: 0, missionSeconds: 40 })
    const first = measure(runToCompletion(createRun(house, cfg, spawn)))

    runToCompletion(createRun(house, defaultConfig({ seed: 1234, noiseMultiplier: 1, missionSeconds: 90 }), spawn))
    runToCompletion(createRun(house, defaultConfig({ seed: 555, noiseMultiplier: 0.5, missionSeconds: 20 }), spawn))

    const again = measure(runToCompletion(createRun(house, cfg, spawn)))
    expect(again.logHash).toBe(first.logHash)
    expect(again.observedCells).toBe(first.observedCells)
  })
})

/**
 * The browser/headless contract, pinned. ADR-001 §2.2.
 *
 * The ADR claims the headless and browser paths execute *identical* simulation code,
 * so a bug reproduced in the browser is a bug in the tests and not a rendering
 * artefact. A claim like that is worth nothing unverified.
 *
 * ## History of this constant
 *
 * - **`2923fbf7`** — verified by hand at Stage D: the viewer at
 *   `http://localhost:4173` reported this hash for seed 1 / noise 1 / jobs on, and
 *   Node produced the same, with the same tick count, coverage and job tally.
 *   It survived Stage E, where adding five ports moved it by one event and the cause
 *   turned out to be a real bug rather than a content change — the constant was only
 *   restored by fixing the bug, never by bumping it.
 * - **`07520de4`** — Stage E part four. Two score-function normalisers were fixed
 *   (`batteryHeadroom` read 1.0 for 100% of bids; `currentLoad` clamped flat), which
 *   made the allocation terms live but did not rescue the policy.
 * - **`8f9dfce8`** — Stage E part five, and **not yet verified in a browser.** The
 *   kill condition fired, the weighted score was deleted, and `score` is no longer
 *   logged on `bid.submitted` or `job.awarded`.
 *
 * ## Behaviour did not change in either move
 *
 * The weighted score was dominated by distance, so deleting it changed no award:
 * tick 3000, coverage 100.00%, jobs 40/31/9, all six per-class metrics and total
 * energy are identical across all three hashes. **A hash tells you the bytes changed;
 * it does not tell you whether the simulation changed** — which is why the
 * behavioural assertions below are pinned separately and are the part of this
 * reference that can be verified without a browser.
 *
 * ## What is and is not verified
 *
 * Verified in Node: the hash, and every behavioural invariant below.
 *
 * **Not verified: that a browser produces this hash.** The browser tooling available
 * when this was written cannot execute page script and does not expose table cell
 * text through its accessibility snapshot, so the viewer's hash cannot be read. The
 * structural claim — one implementation, imported by both paths — still holds and is
 * enforced by `test/boundary/no-render-imports.test.ts`; what is missing is the
 * byte-level cross-engine confirmation, which is the whole point of the pin.
 *
 * So this constant is a tripwire with a known-unverified last reading, not a
 * verified contract. Anyone with a working headless browser should re-run the viewer
 * and confirm or correct it before relying on ADR-001 §2.2.
 */
export const BROWSER_PARITY_HASH = '8f9dfce8'
const BROWSER_PARITY_TICK = 3000

describe('browser/headless parity', () => {
  const parityHouse = loadHouse01()
  const parityRun = () =>
    runToCompletion(
      createRun(
        parityHouse,
        defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, enableJobs: true }),
        { x: -4.5, z: 0.0, theta: 0.0 },
      ),
    )

  it('Node reproduces the hash the browser reported', () => {
    expect(parityRun().log.hash()).toBe(BROWSER_PARITY_HASH)
  })

  it('and reproduces the tick and job tally the browser reported', () => {
    // Pinned alongside the hash so a change cannot match the hash by arriving at a
    // different point in the mission — the hash alone would still pass.
    const run = parityRun()
    expect(run.tick).toBe(BROWSER_PARITY_TICK)
    expect(run.jobTally.announced).toBe(40)
    expect(run.jobTally.done).toBe(31)
    expect(run.jobTally.failed).toBe(9)
  })

  it('and the coverage the browser reported', () => {
    const m = measure(parityRun())
    expect(m.coverageFraction).toBeGreaterThan(0.9999)
    expect(m.logTruncated).toBe(false)
  })

  it('and the per-class detection metrics, which the hash alone would not protect', () => {
    // Deliberately redundant with the hash and worth keeping anyway.
    //
    // The hash moved at Stage E part four for a reason that changed *no* behaviour:
    // a score-function normaliser was fixed, and `bid.submitted` logs the score. A
    // hash tells you the bytes changed; it does not tell you whether the simulation
    // changed. These assertions are the ones that say "the simulation did not", and
    // they are the part of the reference that can be verified without a browser.
    const run = parityRun()
    const scored = scoreDetections(run.candidates, loadAnomalies01(), 'ground')
    const byClass = Object.fromEntries(scored.metrics.byClass.map((r) => [r.cls, r]))

    expect(byClass.blocked_vent?.precision).toBeCloseTo(0.5, 6)
    expect(byClass.blocked_vent?.recall).toBeCloseTo(1.0, 6)
    expect(byClass.clutter_hazard?.precision).toBeCloseTo(0.75, 6)
    expect(byClass.moisture_leak?.precision).toBeCloseTo(0.6666666666666666, 6)
    expect(byClass.pest_indicator?.precision).toBeCloseTo(0.25, 6)
    expect(byClass.pest_indicator?.recall).toBeCloseTo(1.0, 6)
    expect(byClass.thermal_anomaly?.precision).toBeCloseTo(0.25, 6)
    expect(byClass.thermal_anomaly?.recall).toBeCloseTo(1.0, 6)
    expect(measure(run).energyUsedWh).toBeCloseTo(1.0665, 4)
  })

  it('and no agent but one, so the second-bot scenario has not leaked into the baseline', () => {
    const run = parityRun()
    expect(run.agents.length).toBe(1)
    expect(run.contestedAwards, 'the baseline must not be a contested-award run').toBe(0)
  })
})