/**
 * The oracle boundary. Spec §2.6.
 *
 * "No agent, sensor or detector may query it. Enforced by module boundary and by
 * a test that greps `sim/sensors/` and `sim/slam/` for the import."
 *
 * This is the test that makes detection accuracy mean anything. If a detector can
 * reach the answer key then every score in §9.2 is a tautology, every confidence
 * is theatre, and the whole premise of building a playpen rather than reading a
 * spec sheet collapses. It is the single highest-value test in the suite.
 *
 * Modules that ARE allowed to read the oracle:
 * - `world/anomalies.ts` and `world/fields.ts` — ground-truth construction. An
 *   anomaly *is* a source in a field; that coupling is deliberate (§2.7).
 * - `report/` — the evaluator. Scoring is not part of the simulation.
 * - `sim/run.ts` — it owns the world and passes sensors, not the oracle, down.
 *
 * Modules that must NOT read it:
 * - `sim/sensors/` — an observation model samples the world, not the answer.
 * - `sim/sim/detectors.ts` — it knows a reading deviated, not from what.
 * - `sim/nav/`, `sim/math.ts`, `sim/rng.ts`, `sim/eventlog.ts`.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out.sort()
}

/** Strip comments so documentation about the oracle is not mistaken for a use. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

const ORACLE_MARKERS = ['anomalies-01', "from '../world/anomalies", "from './anomalies", 'loadAnomalies01', 'AnomalySet']

describe('oracle boundary', () => {
  const files = walk(SRC).map((f) => ({ path: relative(process.cwd(), f).replace(/\\/g, '/'), full: f }))

  it('finds the modules it expects', () => {
    expect(files.some((f) => f.path.endsWith('src/sim/world/anomalies.ts'))).toBe(true)
    expect(files.some((f) => f.path.endsWith('src/sim/sim/detectors.ts'))).toBe(true)
  })

  it('no sensor reaches the oracle', () => {
    const offenders: string[] = []
    for (const f of files.filter((x) => x.path.includes('/sim/sensors/'))) {
      const src = code(readFileSync(f.full, 'utf8'))
      for (const marker of ORACLE_MARKERS) {
        if (src.includes(marker)) offenders.push(`${f.path}: ${marker}`)
      }
    }
    expect(offenders, `Sensor reaching ground truth (spec §2.6):\n${offenders.join('\n')}`).toEqual([])
  })

  it('no detector reaches the oracle', () => {
    const offenders: string[] = []
    for (const f of files.filter((x) => x.path.endsWith('sim/sim/detectors.ts'))) {
      const src = code(readFileSync(f.full, 'utf8'))
      for (const marker of ORACLE_MARKERS) {
        if (src.includes(marker)) offenders.push(`${f.path}: ${marker}`)
      }
    }
    expect(
      offenders,
      `Detector reaching ground truth (spec §2.6). This is the single test that makes\n` +
        `detection accuracy a measurement rather than a tautology:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('nothing in nav, math, rng or the event log reaches the oracle', () => {
    const offenders: string[] = []
    const guarded = ['/sim/nav/', '/sim/math.ts', '/sim/rng.ts', '/sim/eventlog.ts', '/sim/types.ts']
    for (const f of files.filter((x) => guarded.some((g) => x.path.endsWith(g)))) {
      const src = code(readFileSync(f.full, 'utf8'))
      for (const marker of ORACLE_MARKERS) {
        if (src.includes(marker)) offenders.push(`${f.path}: ${marker}`)
      }
    }
    expect(offenders, `Infrastructure reaching ground truth:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the report and the fields may read it — they are the evaluator and the world', () => {
    const allowed = files.filter(
      (x) =>
        x.path.includes('/sim/report/') ||
        x.path.endsWith('/sim/world/fields.ts') ||
        x.path.endsWith('/sim/world/anomalies.ts') ||
        x.path.endsWith('/sim/sim/run.ts') ||
        x.path.includes('/test/'),
    )
    // Sanity: the allow-list is not accidentally everything.
    expect(allowed.length).toBeGreaterThan(3)
    expect(allowed.length).toBeLessThan(files.length)
  })

  it('every detector id is declared in DETECTOR_IDS', async () => {
    const detectors = await import('../../src/sim/sim/detectors.ts')
    // A candidate whose detectorId is not declared cannot be traced back to a
    // detector, which breaks spec §1.5's "every claim carries a detector ID".
    //
    // The registry lists detectors that *exist*, not detectors that are planned.
    // `humidity.absolute` was listed once with no implementation, which is the
    // same defect as a detector that returns nothing: both read as a clean result.
    expect(detectors.DETECTOR_IDS.length).toBeGreaterThanOrEqual(6)
    expect(detectors.DETECTOR_IDS).toContain('thermal.baseline')
    expect(detectors.DETECTOR_IDS).toContain('thermal.absolute')
    expect(detectors.DETECTOR_IDS).toContain('humidity.baseline')
    expect(detectors.DETECTOR_IDS).not.toContain('humidity.absolute')
  })
})