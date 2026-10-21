/**
 * The yacht domain model: hull form, regions, access graph, faults.
 *
 * ## What this is
 *
 * The second domain for the harness, after the building. It follows the same shape
 * as `world/content.ts` — a content file plus a loader — so that adding a domain is
 * a configuration change and not a fork of the engine.
 *
 * ## The one thing this file exists to compute
 *
 * **Where can a person get to, and where can they not.** That is the question the
 * whole product turns on, and it is a property of the *access graph*, not of the
 * geometry. A void may be large, adjacent to a compartment, and still unreachable.
 *
 * The graph is deliberately crude and deliberately explicit. A hatch declares what
 * it is reached *from* — a region, or `exterior` for a deck hatch — and what it
 * leads *to*. Reachability is a breadth-first walk from the regions a person can
 * simply walk into. Everything the answer depends on is in the content file, so
 * when the content is wrong the answer is wrong in a way that can be pointed at.
 *
 * ## What is assumed
 *
 * Nearly all of it. `content/yacht-01.json` carries an `assumptions` block and
 * `diag-yacht-form.ts` prints it. Nothing here is a measurement of a real boat.
 */

import { buildHullForm, uFromX } from './yacht-form.ts'
import type { HullForm, Principal, Profiles } from './yacht-form.ts'

export type RegionKind = 'compartment' | 'void'
export type Accessibility = 'direct' | 'hatch'

export type YachtRegion = {
  readonly id: string
  readonly name: string
  readonly kind: RegionKind
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
  readonly accessible: Accessibility
}

export type HatchSource = 'exterior' | string

export type YachtHatch = {
  readonly id: string
  readonly name: string
  readonly x: number
  readonly y: number
  readonly kind: string
  /** Where the hatch is reached from. `exterior` means a deck hatch. */
  readonly from: HatchSource
  /** The region the hatch opens into. */
  readonly leadsTo: string
  /**
   * Clear width of the opening, in millimetres.
   *
   * This is the number that separates the two reachability sets. A 150 mm
   * inspection hatch is a route for a person with a torch and a probe and a wall
   * for a 120 mm crawler, and the difference between those two facts is most of
   * the product.
   */
  readonly clearWidthMm: number
  readonly note?: string
}

export type FaultClass =
  | 'void.condensation'
  | 'void.leak'
  | 'enginebay.vapour'
  | 'thermal.hotspot'
  | string

export type YachtFault = {
  readonly id: string
  readonly class: FaultClass
  readonly region: string
  readonly x: number
  readonly y: number
  readonly severity: number
  readonly observable: string
  readonly note?: string
}

export type YachtSource = {
  readonly id: string
  readonly kind: 'thermal' | 'vapour' | 'water'
  readonly x: number
  readonly y: number
  readonly label: string
}

export type YachtModel = {
  readonly id: string
  readonly principal: Principal
  readonly form: HullForm
  readonly levels: Readonly<Record<string, number>>
  readonly regions: readonly YachtRegion[]
  readonly hatches: readonly YachtHatch[]
  readonly faults: readonly YachtFault[]
  readonly sources: readonly YachtSource[]
  readonly assumptions: readonly string[]
  /** Regions a person can reach, and the route. */
  readonly personReachability: ReadonlyMap<string, readonly string[]>
  /** Regions the crawler can reach, and the route. */
  readonly crawlerReachability: ReadonlyMap<string, readonly string[]>
  /** Diameter of the crawler, in millimetres. The parameter that decides whether a hatch is a route or a wall. */
  readonly crawlerDiameterMm: number
  regionAt(x: number, y: number): YachtRegion | undefined
}

export type RawContent = {
  id: string
  note?: string
  principal: Principal
  profiles: Profiles & { _note?: string }
  levels: Readonly<Record<string, number>> & { _note?: string }
  bulkheads: Readonly<Record<string, number>> & { _note?: string }
  regions: readonly YachtRegion[]
  hatches: readonly YachtHatch[]
  sources: readonly YachtSource[]
  faults: readonly YachtFault[]
  assumptions: readonly string[]
  /** Diameter of the crawler in millimetres. Decides whether a hatch is a route or a wall. */
  crawlerDiameterMm?: number
}

/**
 * Reachability by breadth-first walk from the directly-accessible regions.
 *
 * The route is recorded because the *route* is the interesting part: a region
 * reachable only through two hatches is a different proposition from one reachable
 * through one, and the difference is what a person with a torch would have to
 * negotiate.
 *
 * `crawlerDiameterMm` of null means "no size constraint" — the person set.
 * Passing a number applies it: a hatch narrower than the crawler is a wall.
 */
function computeReachability(
  regions: readonly YachtRegion[],
  hatches: readonly YachtHatch[],
  crawlerDiameterMm: number | null,
): Map<string, readonly string[]> {
  const routes = new Map<string, readonly string[]>()
  const queue: { id: string; route: readonly string[] }[] = []
  const passes = (h: YachtHatch): boolean =>
    crawlerDiameterMm === null || h.clearWidthMm >= crawlerDiameterMm

  for (const r of regions) {
    if (r.accessible === 'direct') {
      routes.set(r.id, [r.id])
      queue.push({ id: r.id, route: [r.id] })
    }
  }

  // Exterior hatches seed their target. A person on deck opens the hatch and goes
  // in; the crawler can only do it if the opening is wide enough.
  //
  // This was a bug the first time round: the walk skipped `from === 'exterior'`
  // entirely, which meant the deck hatches had no effect at all and the reachability
  // sweep printed the same number three times. A sweep that cannot move is a
  // diagnostic that cannot fail.
  for (const h of hatches) {
    if (h.from !== 'exterior') continue
    if (!passes(h)) continue
    if (routes.has(h.leadsTo)) continue
    routes.set(h.leadsTo, [h.id])
    queue.push({ id: h.leadsTo, route: [h.id] })
  }

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const h of hatches) {
      if (h.from === 'exterior') continue
      if (current.id !== h.from) continue
      if (!passes(h)) continue
      if (routes.has(h.leadsTo)) continue
      const route = [...current.route, h.id]
      routes.set(h.leadsTo, route)
      queue.push({ id: h.leadsTo, route })
    }
  }
  return routes
}

/** Profile area of a region: the x extent times the height band. A 2-D proxy. */
export function profileArea(region: YachtRegion): number {
  return Math.max(0, region.x1 - region.x0) * Math.max(0, region.y1 - region.y0)
}

/** Total profile area of the regions of a given kind. */
export function totalProfileArea(regions: readonly YachtRegion[], kind: RegionKind): number {
  return regions.filter((r) => r.kind === kind).reduce((sum, r) => sum + profileArea(r), 0)
}

/** Profile area of the regions of a kind that are reachable. */
export function reachableProfileArea(
  regions: readonly YachtRegion[],
  kind: RegionKind,
  routes: ReadonlyMap<string, readonly string[]>,
): number {
  return regions
    .filter((r) => r.kind === kind && routes.has(r.id))
    .reduce((sum, r) => sum + profileArea(r), 0)
}

export function loadYacht01(raw: RawContent): YachtModel {
  const form = buildHullForm(raw.principal, raw.profiles)
  const crawlerDiameterMm = raw.crawlerDiameterMm ?? 0
  const personReachability = computeReachability(raw.regions, raw.hatches, null)
  const crawlerReachability = computeReachability(raw.regions, raw.hatches, crawlerDiameterMm)

  const regionAt = (x: number, y: number): YachtRegion | undefined =>
    raw.regions.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)

  return {
    id: raw.id,
    principal: raw.principal,
    form,
    levels: raw.levels,
    regions: raw.regions,
    hatches: raw.hatches,
    faults: raw.faults,
    sources: raw.sources,
    assumptions: raw.assumptions,
    personReachability,
    crawlerReachability,
    crawlerDiameterMm,
    regionAt,
  }
}

/**
 * Sensitivity: what fraction of void profile area is reachable if the deck hatches
 * were the only access?
 *
 * This is the single most useful output of the domain model, because it converts
 * the unknown that matters — how many hatches there are and where — into a curve.
 * The marine engineer can read the curve and say where the answer crosses the
 * threshold, which is a much easier question to answer than "describe the access".
 */
export function voidReachabilitySweep(
  regions: readonly YachtRegion[],
  hatches: readonly YachtHatch[],
  maxDeckHatches: number,
  crawlerDiameterMm: number | null,
): { readonly kept: number; readonly fraction: number }[] {
  const deckHatches = hatches.filter((h) => h.from === 'exterior')
  const total = totalProfileArea(regions, 'void')
  if (total === 0) return []
  const out: { kept: number; fraction: number }[] = []
  for (let kept = 0; kept <= Math.min(maxDeckHatches, deckHatches.length); kept++) {
    const subset = hatches.filter((h) => h.from !== 'exterior' || deckHatches.indexOf(h) < kept)
    const routes = computeReachability(regions, subset, crawlerDiameterMm)
    out.push({ kept, fraction: reachableProfileArea(regions, 'void', routes) / total })
  }
  return out
}

/** Longitudinal position of a station as a fraction, re-exported for convenience. */
export { uFromX }
