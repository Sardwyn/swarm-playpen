/**
 * The marine fault taxonomy, and the claim it makes.
 *
 * ## The claim
 *
 * A surveyor on a boat is not looking for "a humidity anomaly". They are looking
 * for a cause: condensation, an active leak, historic salt in the core. The
 * taxonomy is the list of those causes, each with what the current instrument
 * suite can and cannot say about it.
 *
 * The instrument produces a **reading** — the `moisture_leak` signature, the
 * `thermal_anomaly` signature. It does not produce a cause, and where several
 * causes share a reading it cannot pick one. So the twin's oracle names the cause
 * *and* declares the reading, the engine matches on the reading, and the report
 * prints the cause with the reading beside it and never pretends the reading
 * settled the cause.
 *
 * ## Why this is tested
 *
 * Because the failure mode is silent and it is expensive. A taxonomy that quietly
 * drifts from the oracle produces a report that attributes findings to causes
 * nobody authored, and a taxonomy that claims observability it does not have
 * produces a product that promises to see corrosion. Both are caught here
 * rather than in front of a customer.
 */

import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRun, defaultConfig, step } from '../../src/sim/sim/run.ts'
import { buildReport } from '../../src/sim/report/report.ts'
import { buildVerdict } from '../../src/sim/report/verdict.ts'
import { GROUND_BOT } from '../../src/sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../../src/sim/types.ts'
import {
  yachtHouse,
  yachtTruth,
  marineTaxonomy,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../../src/sim/world/yacht-sim.ts'
import {
  MARINE_SIGNATURE_IDS,
  causesOf,
  classById,
} from '../../src/sim/world/marine-taxonomy.ts'
import { loadAnomalies01, loadAnomalySet } from '../../src/sim/world/anomalies.ts'

const TOTAL_TICKS = 3000

describe('the taxonomy', () => {
  it('declares causes and the readings that stand behind them', () => {
    expect(marineTaxonomy.classes.length).toBeGreaterThan(0)
    expect(marineTaxonomy.signatures.length).toBeGreaterThan(0)
    for (const s of marineTaxonomy.signatures) {
      expect(s.causes.length, `${s.id} has no causes, so it is a reading with no meaning`).toBeGreaterThan(0)
      expect(s.resolutionRequires.length).toBeGreaterThan(10)
    }
  })

  it('never claims a reading for a cause it cannot see', () => {
    // A class that no instrument can produce must not name a signature. Giving
    // `corrosion_dissimilar_metals` a reading would be the first lie the product
    // tells, and the loader refuses it.
    for (const c of marineTaxonomy.classes) {
      if (c.observable === 'not_observable') {
        expect(c.signatures.length, `${c.id} is marked not_observable but names a signature`).toBe(0)
        expect(c.secondObservable.length).toBeGreaterThan(0)
      } else {
        expect(c.signatures.length, `${c.id} is claimed observable but has no reading`).toBeGreaterThan(0)
      }
    }
  })

  it('says what would be needed to tell the causes apart', () => {
    // Every signature that admits more than one cause must say what resolves it.
    // A signature with several causes and no resolution path is a product that
    // will be asked "so which is it?" and will have nothing to say.
    for (const s of marineTaxonomy.signatures) {
      if (s.causes.length > 1) {
        expect(s.separable, `${s.id} has ${s.causes.length} causes but claims to be separable`).toBe(false)
        expect(s.resolutionRequires.length).toBeGreaterThan(10)
      }
    }
  })

  it('has no cause that a signature does not list', () => {
    for (const s of marineTaxonomy.signatures) {
      for (const cause of s.causes) {
        expect(classById(marineTaxonomy, cause), `${cause} is listed under ${s.id}`).toBeDefined()
      }
    }
    for (const c of marineTaxonomy.classes) {
      for (const sigId of c.signatures) {
        const s = marineTaxonomy.signatures.find((x) => x.id === sigId)!
        expect(s.causes, `${c.id} is not listed under its own signature`).toContain(c.id)
      }
    }
  })

  it('says so when a cause presents two ways', () => {
    // A blocked drain is an obstructed passage *or* an obstruction on the map,
    // depending on where you look. That is allowed, but it has to be declared on
    // both sides: a class that claims a reading the signature does not know
    // about would hide the class from anyone reading that signature's row.
    const multi = marineTaxonomy.classes.filter((c) => c.signatures.length > 1)
    for (const c of multi) {
      for (const sigId of c.signatures) {
        const s = marineTaxonomy.signatures.find((x) => x.id === sigId)!
        expect(s.causes).toContain(c.id)
      }
    }
  })
})

describe('the oracle against the taxonomy', () => {
  it('names only declared causes', () => {
    for (const a of yachtTruth.anomalies) {
      expect(classById(marineTaxonomy, a.class), `${a.id} names ${a.class}`).toBeDefined()
    }
  })

  it('declares the reading the taxonomy says each cause produces', () => {
    for (const a of yachtTruth.anomalies) {
      const c = classById(marineTaxonomy, a.class)!
      expect(
        c.signatures,
        `${a.id} declares ${a.signature}, taxonomy says ${c.signatures.join(', ') || 'nothing'}`,
      ).toContain(a.signature)
    }
  })

  it('contains nothing the taxonomy says cannot be seen', () => {
    // If a class with no reading were in the oracle, the swarm would be scored
    // against a fault that no sensor could ever produce. That is not a hard
    // problem; it is an impossible one, and it would make the recall figure a
    // fiction.
    for (const a of yachtTruth.anomalies) {
      const c = classById(marineTaxonomy, a.class)!
      expect(c.observable, `${a.id} is ${c.observable}`).not.toBe('not_observable')
    }
  })

  it('demonstrates the corroboration problem rather than asserting it', () => {
    // The claim "one humidity reading, several causes" is worth nothing unless the
    // oracle actually contains several causes behind the same reading. Here it
    // does: an active leak, a condensation and a hygroscopic salt equilibrium,
    // all of which read as `moisture_leak` to the sensor.
    const moisture = yachtTruth.anomalies.filter((a) => a.signature === 'moisture_leak')
    expect(moisture.length).toBeGreaterThanOrEqual(3)
    const causes = new Set(moisture.map((a) => a.class))
    expect(causes.size).toBeGreaterThanOrEqual(3)
    expect(causesOf(marineTaxonomy, 'moisture_leak').length).toBeGreaterThanOrEqual(3)
  })

  it('covers a cause from every observable band', () => {
    // At least one cause the instrument can read directly and at least one it can
    // only infer. A taxonomy of nothing but readable causes would be a list of
    // things the product does, not a map of what a survey needs.
    const kinds = new Set(yachtTruth.anomalies.map((a) => classById(marineTaxonomy, a.class)!.observable))
    expect(kinds.has('measurable')).toBe(true)
    expect(kinds.has('indirect')).toBe(true)
  })
})

describe('the report keeps the reading and the cause apart', () => {
  const run = createRun(
    yachtHouse,
    defaultConfig({
      seed: 1,
      noiseMultiplier: 1,
      missionSeconds: 300,
      agents: [GROUND_BOT, INCHWORM, HOVER],
      inchwormHomePort: YACHT_INCHWORM_HOME,
    }),
    YACHT_SPAWN,
    yachtTruth,
  )
  while (run.tick < TOTAL_TICKS && !run.done) step(run)

  const report = buildReport({
    runId: 'taxonomy-test',
    tick: run.tick,
    simSeconds: run.tick / 10,
    candidates: run.candidates,
    truth: run.truth,
    rooms: yachtHouse.rooms,
    coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
    regionCoverage: [],
  })

  const agents = new Map<string, string[]>()
  for (const a of run.agents) agents.set(a.manifold, [...(agents.get(a.manifold) ?? []), a.spec.id])
  const verdict = buildVerdict(report.findings, yachtTruth, agents)

  it('labels a finding with the reading, not the cause', () => {
    for (const f of report.findings) {
      expect(MARINE_SIGNATURE_IDS, `finding ${f.id} claims a class: ${f.class}`).toContain(
        f.class as never,
      )
    }
  })

  it('labels the fault with the cause', () => {
    for (const v of verdict) {
      expect(classById(marineTaxonomy, v.cls), `${v.id} names ${v.cls}`).toBeDefined()
    }
  })

  it('never lets the two vocabularies overlap', () => {
    // If a cause and a reading could share a name, the report could say "the
    // swarm found an active_water_ingress" and mean it as a cause. It cannot.
    const readings = new Set<string>(MARINE_SIGNATURE_IDS)
    for (const c of marineTaxonomy.classes) {
      expect(readings.has(c.id), `${c.id} is both a cause and a reading`).toBe(false)
    }
  })

  it('matches on the reading, so a finding is credited to a cause without claiming to know it', () => {
    let matched = 0
    for (const f of report.findings) {
      if (f.matchedAnomalyId === null) continue
      matched++
      const anomaly = yachtTruth.anomalies.find((a) => a.id === f.matchedAnomalyId)!
      expect(f.class, `finding ${f.id} was matched to a fault of a different reading`).toBe(
        anomaly.signature,
      )
    }
    expect(matched, 'the run must have matched something, or this test proves nothing').toBeGreaterThan(0)
  })
})

describe('the house is unaffected', () => {
  it('uses the class as the signature, so the generic path is unchanged', () => {
    // The house was written before the cause/reading distinction existed. It
    // declares no signature, so the signature falls back to the class and
    // everything downstream behaves exactly as it did.
    const house = loadAnomalies01()
    for (const a of house.anomalies) {
      expect(a.signature).toBe(a.class)
    }
  })

  it('still rejects an unknown signature', () => {
    expect(() =>
      loadAnomalySet({
        id: 'x',
        houseId: 'y',
        coverageThreshold: 0.85,
        matchDistanceM: 3.0,
        anomalies: [
          {
            id: 'a-1',
            class: 'whatever',
            signature: 'not_a_real_signature',
            manifold: 'ground',
            position: [0, 0, 0],
            halfExtents: [1, 1, 1],
            severity: 0.5,
          },
        ],
      }),
    ).toThrow(/unknown signature/)
  })
})

describe('the taxonomy is a domain artifact, not engine knowledge', () => {
  it('is not imported by anything in the simulation core', () => {
    // The engine knows about readings, not about boats. If the engine imported
    // the taxonomy then the "genericisation" would be a fiction and the house
    // would quietly be about yachts.
    //
    // The check is against named files, not a directory, because the generic
    // loaders happen to live in `world/` alongside the domain modules.
    const engineFiles = [
      'src/sim/world/content.ts',
      'src/sim/world/anomalies.ts',
      'src/sim/sim/run.ts',
      'src/sim/sim/detectors.ts',
      'src/sim/sim/agents.ts',
      'src/sim/report/report.ts',
      'src/sim/report/metrics.ts',
      'src/sim/report/verdict.ts',
      'src/sim/report/take.ts',
      'src/sim/report/frame.ts',
    ]
    const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..')
    const offenders: string[] = []
    for (const rel of engineFiles) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8')
      if (text.includes('marine-taxonomy')) offenders.push(rel)
    }
    expect(offenders, 'the engine core must not know about the marine taxonomy').toEqual([])
  })
})
