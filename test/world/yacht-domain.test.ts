/**
 * The yacht domain: does the claim hold?
 *
 * ## The claim
 *
 * On a midships section of a Sunseeker Predator 55, the forward stringer void is
 * the largest volume on the boat, it holds the most severe authored fault, and the
 * swarm cannot reach it — because its only apertures are two 200 mm deck hatches and
 * every agent in the swarm is wider than that.
 *
 * ## Why this is a test and not a diagnostic
 *
 * A diagnostic prints a number and a reader judges it. A test asserts it, and the
 * assertion fails when the geometry changes. The geometry *will* change — that is
 * what happens when the yard's lines plan arrives — and when it does, the test
 * should say so rather than the picture quietly saying something else.
 *
 * So the tests here are of two kinds: the claim above, and the properties that
 * have to keep holding for the claim to mean anything.
 */

import { describe, expect, it } from 'vitest'
import { createRun, defaultConfig, step } from '../../src/sim/sim/run.ts'
import { buildReport } from '../../src/sim/report/report.ts'
import { TakeRecorder, frameFromTake } from '../../src/sim/report/take.ts'
import { buildVerdict, NEAR_CANDIDATE_M } from '../../src/sim/report/verdict.ts'
import { GROUND_BOT } from '../../src/sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../../src/sim/types.ts'
import {
  yachtHouse,
  yachtPrincipal,
  yachtTruth,
  yachtForm,
  yachtAssumptions,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../../src/sim/world/yacht-sim.ts'
import {
  buildHullForm,
  cutPlaneLeavesHullAt,
  hullBottomY,
  hullHalfBreadthAt,
  stationAt,
} from '../../src/sim/world/yacht-form.ts'

const TOTAL_TICKS = 3000

function runTheSwarm(): ReturnType<typeof createRun> {
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
  return run
}

describe('the vessel content', () => {
  it('loads through the same loader as the house', () => {
    expect(yachtHouse.id).toBe('yacht-sim-01')
    expect(yachtHouse.rooms.length).toBeGreaterThan(0)
    expect(yachtHouse.conduits.length).toBeGreaterThan(0)
    expect(yachtHouse.ports.length).toBeGreaterThan(0)
  })

  it('records the assumptions it stands on', () => {
    expect(yachtAssumptions.length).toBeGreaterThan(0)
    expect(yachtAssumptions.some((a) => /NOT|assumed|ASSUMED/i.test(a))).toBe(true)
  })
})

describe('the hull form', () => {
  it('closes the section at every station', () => {
    for (const s of yachtForm.stations) {
      expect(s.keelY, `keel below chine at u=${s.u}`).toBeLessThanOrEqual(s.chineY)
      expect(s.chineY, `chine below sheer at u=${s.u}`).toBeLessThanOrEqual(s.sheerY)
    }
  })

  it('rises forward and narrows forward', () => {
    const aft = stationAt(yachtForm, 0.2)
    const fwd = stationAt(yachtForm, 0.9)
    expect(fwd.keelY).toBeGreaterThan(aft.keelY)
    expect(fwd.sheerZ).toBeLessThan(aft.sheerZ)
    expect(fwd.deadriseDeg).toBeGreaterThan(aft.deadriseDeg)
  })

  it('never puts the hull bottom above the sheer, whatever the offset', () => {
    // The first version extrapolated the topside parameter past 1 when the cut
    // plane was outboard of the sheer, and the profile came out 13.44 m tall on a
    // boat whose sheer is 4.16 m. It was visible in the first render and silent
    // in the diagnostic.
    for (let i = 0; i <= 200; i++) {
      const u = i / 200
      const sheer = stationAt(yachtForm, u).sheerY
      for (const z of [0, 0.2, 0.65, 1.0, 2.0, 2.4, 3.0]) {
        expect(hullBottomY(yachtForm, u, z), `u=${u} z=${z}`).toBeLessThanOrEqual(sheer + 1e-9)
      }
    }
  })

  it('knows where the cut plane leaves the hull', () => {
    const limit = cutPlaneLeavesHullAt(yachtForm, 0.65)
    expect(limit).toBeGreaterThan(0)
    expect(limit).toBeLessThan(yachtPrincipal.loa / 2)
    expect(hullHalfBreadthAt(yachtForm, uOf(limit))).toBeGreaterThanOrEqual(0.65 - 1e-6)
    expect(hullHalfBreadthAt(yachtForm, uOf(limit + 0.05))).toBeLessThan(0.65)
  })

  it('can be built from a different vessel', () => {
    const form = buildHullForm(
      { ...yachtPrincipal, loa: 20, beam: 6 },
      (yachtHouse as unknown as { profiles: never }).profiles ??
        ({
          keelLift: [0.62, 0.8, 0.94, 1, 0.97, 0.86, 0.68, 0.46, 0.26, 0.1, 0.02],
          beamPlan: [0.78, 0.9, 0.97, 1, 1, 0.99, 0.95, 0.86, 0.7, 0.45, 0.08],
          freeboard: [1.78, 1.8, 1.84, 1.9, 1.98, 2.08, 2.2, 2.34, 2.48, 2.6, 2.68],
          deadriseDeg: [19, 20, 21, 22, 24, 27, 31, 35, 40, 45, 50],
          chineRatio: [0.95, 0.95, 0.94, 0.93, 0.92, 0.9, 0.87, 0.82, 0.74, 0.6, 0.35],
        } as never),
    )
    expect(form.stations.length).toBe(11)
  })
})

function uOf(x: number): number {
  return (x + yachtPrincipal.loa / 2) / yachtPrincipal.loa
}

describe('the swarm on the boat', () => {
  const run = runTheSwarm()

  it('finishes the mission', () => {
    expect(run.tick).toBeGreaterThan(1000)
    expect(run.candidates.length).toBeGreaterThan(0)
  })

  it('finds things', () => {
    const report = buildReport({
      runId: 'test',
      tick: run.tick,
      simSeconds: run.tick / 10,
      candidates: run.candidates,
      truth: run.truth,
      rooms: yachtHouse.rooms,
      coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
      regionCoverage: [],
    })
    const found = report.findings.filter((f) => f.matchedAnomalyId !== null)
    expect(found.length).toBeGreaterThan(0)
  })

  it('does NOT find the fault in the stringer void, and the reason is architectural', () => {
    const report = buildReport({
      runId: 'test',
      tick: run.tick,
      simSeconds: run.tick / 10,
      candidates: run.candidates,
      truth: run.truth,
      rooms: yachtHouse.rooms,
      coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
      regionCoverage: [],
    })
    const agents = new Map<string, string[]>()
    for (const a of run.agents) {
      const list = agents.get(a.manifold) ?? []
      list.push(a.spec.id)
      agents.set(a.manifold, list)
    }
    const verdict = buildVerdict(report.findings, yachtTruth, agents)

    const worst = verdict.find((v) => v.id === 'yc-04')
    expect(worst, 'the most severe fault on the vessel must be in the verdict').toBeDefined()
    expect(worst!.found, 'the stringer void must be unreachable by the swarm').toBe(false)
    expect(worst!.kind, 'and the reason must be architectural, not a detection miss').toBe('ARCHITECTURE')
    // Nothing the swarm detected was anywhere near it.
    expect(worst!.detail).toMatch(/nearest candidate .* at [0-9.]+ m/)
  })

  it('separates architectural misses from detection misses', () => {
    // The distinction is the report. A miss with a reason is a finding; a miss
    // without one is a defect. Every miss must land in one of the two buckets,
    // and the two buckets must not be confused with each other.
    const report = buildReport({
      runId: 'test',
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
    for (const v of verdict) {
      expect(['FOUND', 'ARCHITECTURE', 'DETECTION']).toContain(v.kind)
      if (!v.found) {
        expect(v.detail.length).toBeGreaterThan(10)
        expect(['ARCHITECTURE', 'DETECTION']).toContain(v.kind)
      }
    }
    expect(NEAR_CANDIDATE_M).toBeGreaterThan(0)
  })
})

describe('the take', () => {
  it('replays the run it was recorded from', () => {
    const run = runTheSwarm()
    const recorder = new TakeRecorder({
      contentId: yachtHouse.id,
      truth: yachtTruth,
      everyNTicks: 10,
    })
    while (run.tick < TOTAL_TICKS && !run.done) {
      step(run)
      recorder.record(run)
    }
    const report = buildReport({
      runId: 'take-test',
      tick: run.tick,
      simSeconds: run.tick / 10,
      candidates: run.candidates,
      truth: run.truth,
      rooms: yachtHouse.rooms,
      coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
      regionCoverage: [],
    })
    const take = recorder.finish(run, report)

    expect(take.frames.length).toBeGreaterThan(50)
    expect(take.logHash).toBe(run.log.hash())

    // The last frame of the take must carry the coverage the run actually reached.
    const last = frameFromTake(take, take.frames.length - 1)
    let matching = 0
    for (let i = 0; i < last.observed.length; i++) {
      if (last.observed[i] === run.grid.observedCount[i]) matching++
    }
    expect(matching / last.observed.length).toBeGreaterThan(0.999)
  })
})
