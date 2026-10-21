/**
 * Parametric hull form for the yacht domain.
 *
 * ## Why a form generator and not a mesh
 *
 * The viewer's job is to put a thing on screen; the simulation's job is to know where
 * the surfaces are. If the hull were a mesh, the sim would need a renderer type in
 * its import graph and the boundary in ADR-001 §2 would be gone. So the form is
 * computed here, in plain numbers, and the viewer builds meshes from these numbers.
 *
 * Same reasoning as the crawler's pose: a lumen pose of `(conduit, arc)` is correct
 * inside the simulation and meaningless to a renderer, so it is projected at the
 * boundary (`report/frame.ts`).
 *
 * ## What the form is
 *
 * Three longitudinal profiles sampled at eleven stations and linearly interpolated:
 *
 * - **keel rocker** — the height of the bottom of the keel above the baseline
 * - **beam plan** — the half-breadth at the waterline, as a fraction of the maximum
 * - **freeboard** — the height of the sheer above the baseline, less the draft
 *
 * plus a **deadrise** and a **chine ratio** per station, which together give the
 * shape of the section.
 *
 * The section is three points: keel, chine, sheer. That is not a simplification for
 * its own sake — on a planing hull the deadrise section from the keel to the chine
 * is genuinely straight, and the topside from chine to sheer is the flare. A
 * deep-V Sunseeker is described by those three lines and the four profiles above.
 *
 * ## Provenance of the numbers
 *
 * `principal` is Sunseeker's published specification. The `profiles` are DERIVED and
 * are marked ASSUMED in `content/yacht-01.json`. They are placeholders shaped to be
 * plausible, not measurements, and they must be replaced with the yard's lines plan
 * before any of them is quoted as a fact about a boat.
 *
 * This file does not know the difference between a plausible number and a true one,
 * and neither does anything downstream of it. The `assumptions` block in the content
 * file is the only place that difference is recorded, which is why the content file
 * carries one.
 */

export type Profiles = {
  /**
   * How far the keel is lifted above its lowest point, as a fraction of the draft.
   *
   * Zero at the deepest station, one at the ends. The keel bottom height is
   * `draft * (1 - keelLift)`, so the lowest point of the keel sits ON the baseline
   * and everything else is above it.
   *
   * The first version of this profile was inverted — it read as a height above the
   * baseline rather than a lift, which put the keel amidships a metre and a half
   * *above* the baseline and the stem on it. A test caught it. The description is
   * here so that the next reader does not have to.
   */
  readonly keelLift: readonly number[]
  /** Half-breadth at the waterline, as a fraction of the maximum beam. */
  readonly beamPlan: readonly number[]
  /** Height of the sheer above the baseline, less the draft. */
  readonly freeboard: readonly number[]
  /** Deadrise in degrees from horizontal, keel to chine. */
  readonly deadriseDeg: readonly number[]
  /** Half-breadth at the chine, as a fraction of the half-breadth at the sheer. */
  readonly chineRatio: readonly number[]
}

export type Principal = {
  readonly loa: number
  readonly beam: number
  readonly draft: number
  readonly displacementKg: number
  readonly fuelLitres: number
  readonly freshWaterLitres: number
  readonly source: string
}

export type Station = {
  /** 0 at the transom, 1 at the stem. */
  readonly u: number
  /** Longitudinal position, metres, negative aft of midships. */
  readonly x: number
  readonly keelY: number
  readonly chineY: number
  readonly chineZ: number
  readonly sheerY: number
  readonly sheerZ: number
  readonly deadriseDeg: number
}

export type HullForm = {
  readonly principal: Principal
  readonly stations: readonly Station[]
}

/** Number of profile samples. Eleven: u = 0.0, 0.1, ... 1.0. */
export const PROFILE_SAMPLES = 11

/**
 * Linear interpolation over a sampled profile.
 *
 * Linear, not smooth. A spline through eleven points invents curvature that no
 * source describes, and this project has already been caught once by a model that
 * looked right and was not — the volumetric free space was the union of room AABBs,
 * which measured as six connected components, one per room, because rooms do not
 * overlap at their doorways. The interpolation here is deliberately the dullest one
 * available, because the dullest one cannot invent a feature.
 */
export function sampleProfile(values: readonly number[], u: number): number {
  if (values.length === 0) return 0
  if (values.length === 1) return values[0]!
  const t = Math.min(1, Math.max(0, u)) * (values.length - 1)
  const i = Math.min(values.length - 2, Math.floor(t))
  const f = t - i
  return values[i]! * (1 - f) + values[i + 1]! * f
}

export function buildHullForm(principal: Principal, profiles: Profiles): HullForm {
  const stations: Station[] = []
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    const u = i / (PROFILE_SAMPLES - 1)
    const keelY = principal.draft * (1 - sampleProfile(profiles.keelLift, u))
    const sheerZ = (principal.beam / 2) * sampleProfile(profiles.beamPlan, u)
    const chineZ = sheerZ * sampleProfile(profiles.chineRatio, u)
    const deadriseDeg = sampleProfile(profiles.deadriseDeg, u)
    // The deadrise section is straight, so the chine sits on the line from the keel
    // at the local deadrise angle. Deriving it this way rather than reading it from a
    // table keeps the section self-consistent: change the deadrise and the chine
    // moves with it.
    const chineY = keelY + chineZ * Math.tan((deadriseDeg * Math.PI) / 180)
    stations.push({
      u,
      x: -principal.loa / 2 + u * principal.loa,
      keelY,
      chineY,
      chineZ,
      sheerY: principal.draft + sampleProfile(profiles.freeboard, u),
      sheerZ,
      deadriseDeg,
    })
  }
  return { principal, stations }
}

/** The station at an arbitrary longitudinal position, interpolated. */
export function stationAt(form: HullForm, u: number): Station {
  const t = Math.min(1, Math.max(0, u)) * (PROFILE_SAMPLES - 1)
  const i = Math.min(form.stations.length - 2, Math.floor(t))
  const f = t - i
  const a = form.stations[i]!
  const b = form.stations[i + 1]!
  const mix = (p: number, q: number): number => p * (1 - f) + q * f
  return {
    u: mix(a.u, b.u),
    x: mix(a.x, b.x),
    keelY: mix(a.keelY, b.keelY),
    chineY: mix(a.chineY, b.chineY),
    chineZ: mix(a.chineZ, b.chineZ),
    sheerY: mix(a.sheerY, b.sheerY),
    sheerZ: mix(a.sheerZ, b.sheerZ),
    deadriseDeg: mix(a.deadriseDeg, b.deadriseDeg),
  }
}

/**
 * Height of the hull's inner surface at a longitudinal position and a transverse
 * offset from the centreline.
 *
 * Below the chine the section is the straight deadrise line. Above it, the topside
 * runs from the chine to the sheer, which flares outboard, so the inner surface at
 * a given height is narrower than the sheer.
 */
export function hullBottomY(form: HullForm, u: number, z: number): number {
  const s = stationAt(form, u)
  const a = Math.abs(z)
  if (a <= s.chineZ) {
    return s.keelY + a * Math.tan((s.deadriseDeg * Math.PI) / 180)
  }
  if (s.sheerZ <= s.chineZ) return s.chineY
  const t = (a - s.chineZ) / (s.sheerZ - s.chineZ)
  return s.chineY + t * (s.sheerY - s.chineY)
}

/** Height of the sheer (deck edge) at a longitudinal position. */
export function hullTopY(form: HullForm, u: number): number {
  return stationAt(form, u).sheerY
}

/** Longitudinal position as a fraction of the length, from a station's x. */
export function uFromX(form: HullForm, x: number): number {
  const half = form.principal.loa / 2
  return Math.min(1, Math.max(0, (x + half) / form.principal.loa))
}

/**
 * The interior band at a station: where the inside of the hull is, at a transverse
 * offset.
 *
 * `bottom` is the inner surface of the hull. `top` is the sheer, which for this
 * vessel is the level of the main deck edge.
 */
export function interiorSpan(
  form: HullForm,
  u: number,
  z: number,
): { readonly bottomY: number; readonly topY: number } {
  return { bottomY: hullBottomY(form, u, z), topY: hullTopY(form, u) }
}
