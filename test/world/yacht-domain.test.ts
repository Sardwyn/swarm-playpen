/**
 * The yacht domain: the access graph, and the shape of the hull.
 *
 * ## Why the access graph is the thing under test
 *
 * The domain's job is to answer "where can we get, and where can we not", because
 * that answer decides whether the product has a job. A geometry that looks right and
 * an access graph that is quietly wrong produce the same picture and opposite
 * conclusions, so the graph is tested directly.
 *
 * ## The regression that matters most
 *
 * The first implementation of the breadth-first walk skipped hatches whose source
 * was `exterior`, on the reasoning that an exterior hatch was not an edge between
 * two regions. That is wrong: an exterior hatch is how a person on deck gets into a
 * void. The walk therefore reported every void as reachable regardless of the
 * hatches, and the sensitivity sweep printed the same number three times.
 *
 * A sweep that cannot move is a diagnostic that cannot fail. That is the whole
 * reason this file exists.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadYacht01,
  profileArea,
  totalProfileArea,
  reachableProfileArea,
  voidReachabilitySweep,
} from '../../src/sim/world/yacht.ts'
import type { RawContent } from '../../src/sim/world/yacht.ts'
import {
  buildHullForm,
  hullBottomY,
  stationAt,
  uFromX,
} from '../../src/sim/world/yacht-form.ts'

const raw = JSON.parse(
  readFileSync(join(process.cwd(), 'src', 'content', 'yacht-01.json'), 'utf8'),
) as RawContent
const model = loadYacht01(raw)

describe('hull form', () => {
  it('closes the section at every station', () => {
    for (const s of model.form.stations) {
      expect(s.keelY, `keel below chine at u=${s.u}`).toBeLessThanOrEqual(s.chineY)
      expect(s.chineY, `chine below sheer at u=${s.u}`).toBeLessThanOrEqual(s.sheerY)
    }
  })

  it('rises forward and narrows forward', () => {
    const aft = stationAt(model.form, 0.2)
    const fwd = stationAt(model.form, 0.9)
    expect(fwd.keelY).toBeGreaterThan(aft.keelY)
    expect(fwd.sheerZ).toBeLessThan(aft.sheerZ)
    expect(fwd.deadriseDeg).toBeGreaterThan(aft.deadriseDeg)
  })

  it('puts the lowest point of the keel on the baseline', () => {
    // The baseline is y = 0 at the deepest point of the keel, so no station may be
    // below it, and at least one must be on it. The first version of the keel
    // profile was inverted and put the keel a metre and a half above the baseline
    // amidships with the stem sitting on it; this is the test that catches it.
    const lowest = Math.min(...model.form.stations.map((s) => s.keelY))
    expect(lowest).toBeGreaterThanOrEqual(-1e-9)
    expect(lowest).toBeLessThan(0.05)
    for (const s of model.form.stations) {
      expect(s.keelY).toBeGreaterThanOrEqual(-1e-9)
    }
  })

  it('keeps the sheer above the waterline everywhere', () => {
    for (const s of model.form.stations) {
      expect(s.sheerY, `sheer below the waterline at u=${s.u}`).toBeGreaterThan(
        model.principal.draft,
      )
    }
  })

  it('has the hull bottom rising with the distance off the centreline', () => {
    const u = uFromX(model.form, 0)
    expect(hullBottomY(model.form, u, 0)).toBeLessThan(hullBottomY(model.form, u, 0.5))
  })
})

describe('content consistency', () => {
  it('has no two regions overlapping', () => {
    for (let i = 0; i < model.regions.length; i++) {
      for (let j = i + 1; j < model.regions.length; j++) {
        const a = model.regions[i]!
        const b = model.regions[j]!
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
        expect(ox > 0 && oy > 0, `'${a.id}' overlaps '${b.id}'`).toBe(false)
      }
    }
  })

  it('puts every region inside the hull at the cut plane', () => {
    for (const r of model.regions) {
      const u = uFromX(model.form, (r.x0 + r.x1) / 2)
      const st = stationAt(model.form, u)
      expect(0.65, `cut plane outside the hull at '${r.id}'`).toBeLessThan(st.sheerZ)
      expect(r.y0, `'${r.id}' starts below the hull bottom`).toBeGreaterThan(
        hullBottomY(model.form, u, 0.65) - 0.05,
      )
      expect(r.y1, `'${r.id}' ends above the sheer`).toBeLessThan(st.sheerY + 0.05)
    }
  })

  it('puts every fault inside its own region', () => {
    for (const f of model.faults) {
      const r = model.regions.find((x) => x.id === f.region)
      expect(r, `fault '${f.id}' in unknown region`).toBeDefined()
      expect(f.x).toBeGreaterThanOrEqual(r!.x0)
      expect(f.x).toBeLessThanOrEqual(r!.x1)
      expect(f.y).toBeGreaterThanOrEqual(r!.y0)
      expect(f.y).toBeLessThanOrEqual(r!.y1)
    }
  })

  it('gives every hatch a target that exists', () => {
    for (const h of model.hatches) {
      expect(model.regions.some((r) => r.id === h.leadsTo), `hatch '${h.id}'`).toBe(true)
      expect(h.clearWidthMm).toBeGreaterThan(0)
    }
  })
})

describe('access graph', () => {
  it('reaches a void through an exterior hatch', () => {
    // The regression. An exterior hatch is a route, not a non-edge.
    const exteriorHatch = model.hatches.find((h) => h.from === 'exterior')
    expect(exteriorHatch, 'the content needs at least one exterior hatch to test this').toBeDefined()
    expect(model.personReachability.has(exteriorHatch!.leadsTo)).toBe(true)
  })

  it('loses the route when the exterior hatch is removed', () => {
    const withoutDeck = model.hatches.filter((h) => h.from !== 'exterior')
    const stripped = loadYacht01({ ...raw, hatches: withoutDeck })
    const deckTarget = model.hatches.find((h) => h.from === 'exterior')!.leadsTo
    expect(stripped.personReachability.has(deckTarget)).toBe(false)
  })

  it('treats a hatch narrower than the crawler as a wall for the crawler only', () => {
    const narrow = model.hatches.find((h) => h.clearWidthMm < model.crawlerDiameterMm)
    if (narrow === undefined) {
      // The content happens to have wide hatches. The property still has to hold for
      // a synthetic one, or the model has no notion of clearance at all.
      const synthetic = loadYacht01({
        ...raw,
        hatches: raw.hatches.map((h) =>
          h.id === raw.hatches[0]!.id ? { ...h, clearWidthMm: 10 } : h,
        ),
      })
      const target = raw.hatches[0]!.leadsTo
      expect(synthetic.personReachability.has(target)).toBe(true)
      expect(synthetic.crawlerReachability.has(target)).toBe(false)
      return
    }
    expect(model.personReachability.has(narrow.leadsTo)).toBe(true)
    expect(model.crawlerReachability.has(narrow.leadsTo)).toBe(false)
  })

  it('produces a sweep that actually moves', () => {
    const sweep = voidReachabilitySweep(model.regions, model.hatches, 3, null)
    expect(sweep.length).toBeGreaterThan(1)
    const fractions = sweep.map((p) => p.fraction)
    // Monotonic: keeping more hatches cannot make less reachable.
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!)
    }
    // And it must change. A sweep that prints the same number twice is the bug the
    // first implementation had.
    expect(fractions[fractions.length - 1]!).toBeGreaterThan(fractions[0]!)
  })

  it('accounts for every region of void area in one of the three buckets', () => {
    const total = totalProfileArea(model.regions, 'void')
    const person = reachableProfileArea(model.regions, 'void', model.personReachability)
    const crawler = reachableProfileArea(model.regions, 'void', model.crawlerReachability)
    expect(person).toBeLessThanOrEqual(total + 1e-9)
    expect(crawler).toBeLessThanOrEqual(total + 1e-9)
    // A person with a torch and a probe is not a smaller thing than a crawler.
    expect(person).toBeGreaterThanOrEqual(crawler - 1e-9)
  })
})

describe('the domain does not know which numbers are real', () => {
  it('records every assumption it is standing on', () => {
    expect(model.assumptions.length).toBeGreaterThan(0)
    // The principal characteristics are published; everything else is not, and the
    // file says so rather than leaving a reader to guess.
    expect(model.principal.source).toMatch(/Sunseeker/)
    expect(model.assumptions.some((a) => /NOT/i.test(a))).toBe(true)
  })
})

describe('a form built from nothing is still a form', () => {
  it('does not care about the vessel to build a hull', () => {
    const form = buildHullForm(
      { ...model.principal, loa: 20, beam: 6 },
      raw.profiles,
    )
    expect(form.stations.length).toBe(11)
    expect(profileArea({ ...model.regions[0]!, x1: model.regions[0]!.x0 + 1 })).toBeGreaterThan(0)
  })
})
