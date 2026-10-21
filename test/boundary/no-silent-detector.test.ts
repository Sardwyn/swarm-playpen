/**
 * The no-silent-detector guard.
 *
 * The recurring defect class in this project, recorded in spec §11.6:
 *
 *   **A detector that returns nothing is indistinguishable from a building with
 *   nothing wrong in it.**
 *
 * It bit twice at Stage B. A magnitude gate of 118 K silenced the naive thermal
 * control for an entire stage, and every "the naive detector loses" assertion
 * passed *vacuously* — a test suite confidently reporting a result it never
 * measured. Then every occupied cell in the house sat at zero surface
 * observations, so the crack proxy and the pest proxy both returned a perfectly
 * plausible `0.00` that read as a clean building.
 *
 * This file is the precondition for trusting anything higher up. Stage C adds an
 * auction, a regret metric and a handoff chain; all three would inherit the same
 * blindness, and a regret number computed over silently-dead detectors is worse
 * than no regret number because it looks like evidence.
 *
 * So: every registered detector must emit at least one candidate over the control
 * scenario, unless it is declared silent **with a reason**. The allow-list is the
 * point. A detector cannot go quiet without someone writing down why, and that
 * record is what distinguishes a known limitation from a bug.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { createRun, defaultConfig, runToCompletion } from '../../src/sim/sim/run.ts'
import { DETECTOR_IDS } from '../../src/sim/sim/detectors.ts'
import { GROUND_BOT } from '../../src/sim/sim/agents.ts'
import { INCHWORM } from '../../src/sim/types.ts'

const house = loadHouse01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

/**
 * Detectors permitted to be silent, each with the reason it is legitimate.
 *
 * Every entry is a *design* limitation with an owner, not a workaround. Adding to
 * this list is a decision that gets reviewed; discovering a silent detector that
 * is not on this list is a bug that gets fixed.
 */
const EXPECTED_SILENT: Record<string, string> = {
  'geometry.crack_proxy':
    'structural_crack is undetectable at Stage B (spec §13.7). A geometry-only proxy resolves a thin isolated ' +
    'linear obstacle, not a hairline crack in a wall surface; and a feature thin enough to proxy-detect is ' +
    'thinner than the navigation inflation band, so the robot cannot approach it. Fixing this needs a sensor, ' +
    'not a threshold.',
}

/**
 * Which scenario each detector needs in order to be able to emit at all.
 *
 * Added at Stage E for constrained.obstruction, and the point is what it *prevents*
 * rather than what it enables.
 *
 * The obvious way to make this guard pass with a crawler-only detector was to add it
 * to EXPECTED_SILENT. That would have been wrong twice over: the detector works, and
 * an allow-list entry means "this emits nothing, and that is fine" - so the one
 * detector that had just been given a real instrument would have been recorded as
 * permanently broken. It is also precisely the move this file exists to prevent.
 *
 * So every detector declares the agents it needs, and is checked against a run that
 * has them. A new detector therefore has to state its scenario rather than quietly
 * inheriting someone else's run.
 */
const DETECTOR_SCENARIO: Record<string, 'ground' | 'swarm'> = {
  'constrained.obstruction': 'swarm',
}

describe('no silent detectors', () => {
  const run = runToCompletion(
    createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 300 }), spawn),
  )

  // A second run, with the crawler, for detectors that cannot work without it. Kept
  // separate rather than merged into one scenario so that a detector needing the
  // ground bot is still checked on a ground-only run — one rich scenario would let a
  // crawler mask a dead ground detector.
  const swarmRun = runToCompletion(
    createRun(
      house,
      defaultConfig({
        seed: 1,
        noiseMultiplier: 0,
        missionSeconds: 300,
        agents: [GROUND_BOT, INCHWORM],
        inchwormHomePort: 'duct-drop-utility',
      }),
      spawn,
    ),
  )

  const countsFor = (source: typeof run): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const c of source.candidates) out[c.detectorId] = (out[c.detectorId] ?? 0) + 1
    return out
  }

  const counts = countsFor(run)
  const swarmCounts = countsFor(swarmRun)

  /** Counts from whichever scenario the detector declared it needs. */
  const countsForDeclaredScenario = (id: string): number => {
    const which = DETECTOR_SCENARIO[id] ?? 'ground'
    return (which === 'swarm' ? swarmCounts : counts)[id] ?? 0
  }

  it('the registry is not empty and has no duplicate entries', () => {
    expect(DETECTOR_IDS.length).toBeGreaterThanOrEqual(6)
    expect(new Set(DETECTOR_IDS).size).toBe(DETECTOR_IDS.length)
  })

  it('every allow-list entry names a detector that actually exists', () => {
    // A stale allow-list entry is worse than none: it permanently excuses a
    // detector nobody is checking any more.
    for (const id of Object.keys(EXPECTED_SILENT)) {
      expect(
        (DETECTOR_IDS as readonly string[]).includes(id),
        `allow-list names '${id}', which is not in DETECTOR_IDS`,
      ).toBe(true)
    }
  })

  it('every allow-list entry gives a reason of substance', () => {
    for (const [id, reason] of Object.entries(EXPECTED_SILENT)) {
      expect(reason.length, `${id} needs a real reason, not a placeholder`).toBeGreaterThan(80)
    }
  })

  it('every detector either emits a candidate or is declared silent', () => {
    const silent: string[] = []
    for (const id of DETECTOR_IDS) {
      if (countsForDeclaredScenario(id) === 0 && !(id in EXPECTED_SILENT)) silent.push(id)
    }
    expect(
      silent,
      'Detectors that emitted nothing in their declared scenario and are not declared silent.\n' +
        'This is the Stage B failure mode: a dead detector reads as a clean building,\n' +
        'and every metric computed over it is meaningless.\n' +
        'Either fix the detector, or give it the agents it needs in DETECTOR_SCENARIO,\n' +
        'or declare it in EXPECTED_SILENT with a reason.',
    ).toEqual([])
  })

  it('every declared scenario names a real detector, and the declaration is load-bearing', () => {
    for (const id of Object.keys(DETECTOR_SCENARIO)) {
      expect(
        (DETECTOR_IDS as readonly string[]).includes(id),
        "DETECTOR_SCENARIO names '" + id + "', which is not in DETECTOR_IDS",
      ).toBe(true)
    }
    // A crawler-only detector must actually be silent on the ground-only run.
    // Otherwise the scenario declaration is decoration, and either the ground
    // detectors or the crawler detectors are not being checked as claimed.
    for (const id of Object.keys(DETECTOR_SCENARIO)) {
      if (DETECTOR_SCENARIO[id] !== 'swarm') continue
      expect(counts[id] ?? 0, id + ' claims it needs a crawler but fired without one').toBe(0)
      expect(swarmCounts[id] ?? 0, id + ' fired without the crawler it declares it needs').toBeGreaterThan(0)
    }
  })

  it('the declared-silent detector really is silent, so the allow-list cannot rot', () => {
    // The mirror of the test above. Without this, an allow-list entry would keep
    // excusing a detector that has since started working, and the real reason
    // would be lost.
    for (const id of Object.keys(EXPECTED_SILENT)) {
      expect(counts[id] ?? 0, `${id} is declared silent but is emitting`).toBe(0)
    }
  })

  it('the detectors that do work, all work at nominal noise too', () => {
    // Zero noise is the control; a detector that only fires when noise happens to
    // align is not a detector.
    const nominal = runToCompletion(
      createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300 }), spawn),
    )
    const nominalCounts = countsFor(nominal)
    for (const id of DETECTOR_IDS) {
      if (id in EXPECTED_SILENT) continue
      if (DETECTOR_SCENARIO[id] === 'swarm') continue
      expect(nominalCounts[id] ?? 0, `${id} fired at zero noise but not at nominal`).toBeGreaterThan(0)
    }
  })

  it('the naive control fires — the comparison it exists for is not vacuous', () => {
    // Called out separately because it is the one that failed hardest: a 118 K
    // magnitude gate meant "the naive detector loses" was true for an entire
    // stage without the naive detector ever having run.
    expect(counts['thermal.absolute'] ?? 0).toBeGreaterThan(0)
  })

  it('every candidate names a registered detector', () => {
    const known = new Set<string>(DETECTOR_IDS)
    for (const c of run.candidates) {
      expect(known.has(c.detectorId), `candidate cites unregistered detector '${c.detectorId}'`).toBe(true)
    }
  })
})
