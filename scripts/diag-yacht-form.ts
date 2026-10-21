/**
 * Diagnostic for the yacht domain content.
 *
 * ## Why this exists
 *
 * The last time a stage was started, the content was broken and nobody knew until
 * four defects turned up:
 *
 *   "STAGE F STARTED WITH THE CONTENT, AND THE CONTENT WAS BROKEN. Before writing
 *   any hover bot I read what the stage gate would be measured against, and found
 *   four defects no test had caught - including **no attic anywhere**, which would
 *   have meant the hover bot's 1.0 m ceiling clearance **never binds**."
 *
 * A constraint that does not bind reads exactly like a constraint that costs
 * nothing. So: read the content before building on it, and check it against the
 * stage gate, not against what it is supposed to mean.
 *
 * ## What this prints
 *
 * 1. The station table, so the hull form can be eyeballed.
 * 2. An inboard profile at the cut plane, which is the picture the domain is
 *    actually about: what is enclosed, what is reachable, and what is not.
 * 3. The access graph, and a sweep of void reachability against the number of deck
 *    hatches, because "how many hatches and where" is the unknown that decides
 *    whether the product has a job.
 * 4. The faults, against reachability.
 * 5. The defects found in the content, and the assumptions that must be replaced
 *    before any of this is quoted as a fact about a boat.
 *
 * Run: `npm run diag:yacht`
 */

import {
  profileArea,
  totalProfileArea,
  reachableProfileArea,
  voidReachabilitySweep,
} from '../src/sim/world/yacht.ts'
import { yacht as model } from '../src/sim/world/yacht-content.ts'
import { hullBottomY, hullTopY, stationAt, uFromX } from '../src/sim/world/yacht-form.ts'

const CUT_Z = 0.65

/**
 * The content is loaded through `sim/world/yacht-content.ts`, the same module the
 * browser scene imports, so the ASCII profile printed here and the picture on
 * screen are the same boat.
 */

const form = model.form

const COLS = 132
const ROWS = 42

function line(char = '-', width = 78): string {
  return char.repeat(width)
}

function heading(text: string): void {
  console.log('')
  console.log(text)
  console.log(line())
}

// ---------------------------------------------------------------- station table

heading('1. STATIONS')

console.log(
  ['   u', '      x', '  keelY', ' chineY', ' sheerY', ' dr°'].join('  '),
)
for (const s of form.stations) {
  console.log(
    [
      s.u.toFixed(1).padStart(5),
      s.x.toFixed(2).padStart(7),
      s.keelY.toFixed(3).padStart(7),
      s.chineY.toFixed(3).padStart(7),
      s.sheerY.toFixed(3).padStart(7),
      s.deadriseDeg.toFixed(0).padStart(4),
    ].join('  '),
  )
}

// ------------------------------------------------------------ inboard profile

heading(`2. INBOARD PROFILE at z = ${CUT_Z.toFixed(2)} m (starboard of centreline)`)

const maxY = Math.max(...form.stations.map((s) => s.sheerY))
const x0 = -form.principal.loa / 2
const x1 = form.principal.loa / 2

/** Classify a cell. Returns a character, or null for "leave as background". */
function cellChar(x: number, y: number): string | null {
  const u = uFromX(form, x)
  const bottom = hullBottomY(form, u, CUT_Z)
  const top = hullTopY(form, u)

  if (y > top) return ' '
  if (y > bottom) {
    const region = model.regionAt(x, y)
    if (region === undefined) return ' '
    return region.kind === 'void' ? '.' : region.id.startsWith('engine') ? 'E' : 'C'
  }
  if (Math.abs(y - bottom) < 0.07 || Math.abs(y - top) < 0.07) return '#'
  return ':'
}

const rows: string[] = []
for (let r = ROWS - 1; r >= 0; r--) {
  const y = (r / (ROWS - 1)) * maxY
  const line2: string[] = []
  for (let c = 0; c < COLS; c++) {
    const x = x0 + (c / (COLS - 1)) * (x1 - x0)
    const ch = cellChar(x, y)
    line2.push(ch === null ? ' ' : ch)
  }
  rows.push(line2.join(''))
}

/** Overlays, drawn after the base raster so they win. */
function overlay(ch: string, x: number, y: number): void {
  const c = Math.round(((x - x0) / (x1 - x0)) * (COLS - 1))
  const r = Math.round((y / maxY) * (ROWS - 1))
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return
  const row = rows[ROWS - 1 - r]!
  rows[ROWS - 1 - r] = row.slice(0, c) + ch + row.slice(c + 1)
}

for (const s of model.sources) {
  const ch = s.kind === 'thermal' ? 'T' : s.kind === 'vapour' ? 'V' : 'w'
  overlay(ch, s.x, s.y)
}
for (const f of model.faults) overlay('^', f.x, f.y)
for (const h of model.hatches) overlay('H', h.x, h.y)

console.log('   ' + ' '.repeat(COLS))
for (const row of rows) console.log('   ' + row)
console.log('   ' + ' '.repeat(COLS))

// Legend, and the vessel's principal dimensions drawn to the same scale.
const wlRow = Math.round((form.principal.draft / maxY) * (ROWS - 1))
const wlLine = rows[ROWS - 1 - wlRow]!.replace(/[^:]/g, '~')
console.log('   ' + wlLine)
console.log(
  `   waterline y = ${form.principal.draft.toFixed(2)} m` +
    `   |   LOA ${form.principal.loa.toFixed(2)} m   beam ${form.principal.beam.toFixed(2)} m`,
)

// -------------------------------------------------------------- access graph

heading('3. ACCESS GRAPH')

console.log(
  `  crawler diameter ${model.crawlerDiameterMm} mm — a hatch narrower than this is a wall, not a route`,
)
console.log('')
for (const r of model.regions) {
  const person = model.personReachability.get(r.id)
  const crawler = model.crawlerReachability.get(r.id)
  const area = profileArea(r)
  const fmt = (route: readonly string[] | undefined): string =>
    route === undefined
      ? 'UNREACHABLE'
      : `via ${route.slice(1).join(' -> ') || 'direct'}`
  console.log(
    `  ${r.id.padEnd(22)} ${r.kind.padEnd(12)} ${area.toFixed(1).padStart(7)} m²` +
      `  person: ${fmt(person).padEnd(34)} crawler: ${fmt(crawler)}`,
  )
}

console.log('')
console.log('  hatches:')
for (const h of model.hatches) {
  const personOk = true
  const crawlerOk = h.clearWidthMm >= model.crawlerDiameterMm
  console.log(
    `    ${h.id.padEnd(24)} ${String(h.clearWidthMm).padStart(4)} mm  ` +
      `from ${h.from.padEnd(12)} to ${h.leadsTo.padEnd(22)} ` +
      `person ${personOk ? 'pass' : 'FAIL'}  crawler ${crawlerOk ? 'pass' : 'WALL'}`,
  )
}

const voidTotal = totalProfileArea(model.regions, 'void')
const voidPerson = reachableProfileArea(model.regions, 'void', model.personReachability)
const voidCrawler = reachableProfileArea(model.regions, 'void', model.crawlerReachability)
console.log('')
console.log(`  void profile area            ${voidTotal.toFixed(1)} m²`)
console.log(
  `  reachable by a person        ${voidPerson.toFixed(1)} m²  (${((voidPerson / voidTotal) * 100).toFixed(1)}%)`,
)
console.log(
  `  reachable by the crawler     ${voidCrawler.toFixed(1)} m²  (${((voidCrawler / voidTotal) * 100).toFixed(1)}%)`,
)
console.log(
  `  reachable by neither         ${(voidTotal - Math.max(voidPerson, voidCrawler)).toFixed(1)} m²` +
    `  (${(((voidTotal - Math.max(voidPerson, voidCrawler)) / voidTotal) * 100).toFixed(1)}%)`,
)

console.log('')
console.log('  sensitivity — reachable void area against deck hatches retained:')
console.log('    by person:')
for (const p of voidReachabilitySweep(model.regions, model.hatches, 3, null)) {
  const bar = '#'.repeat(Math.round(p.fraction * 40))
  console.log(
    `      ${String(p.kept).padStart(2)} hatch(es)  ${(p.fraction * 100).toFixed(1).padStart(5)}%  ${bar}`,
  )
}
console.log('    by crawler:')
for (const p of voidReachabilitySweep(
  model.regions,
  model.hatches,
  3,
  model.crawlerDiameterMm,
)) {
  const bar = '#'.repeat(Math.round(p.fraction * 40))
  console.log(
    `      ${String(p.kept).padStart(2)} hatch(es)  ${(p.fraction * 100).toFixed(1).padStart(5)}%  ${bar}`,
  )
}

// ------------------------------------------------------------------- faults

heading('4. FAULTS AGAINST REACHABILITY')

for (const f of model.faults) {
  const person = model.personReachability.get(f.region)
  const crawler = model.crawlerReachability.get(f.region)
  console.log(
    `  ${f.id.padEnd(18)} ${f.class.padEnd(20)} ${f.region.padEnd(22)} ` +
      `severity ${f.severity}  observable ${f.observable.padEnd(9)} ` +
      `person ${person === undefined ? 'NO' : 'yes'}  crawler ${crawler === undefined ? 'NO' : 'yes'}`,
  )
  if (f.note !== undefined) console.log(`      ${f.note}`)
}

// ------------------------------------------------------------ content defects

heading('5. DEFECTS FOUND IN THE CONTENT')

const defects: string[] = []

// Regions must not overlap. The volumetric free space was the union of room AABBs,
// which measured as six connected components because rooms did not overlap at their
// doorways. The same class of bug here would be a region that overlaps another and
// makes the access graph ambiguous.
for (let i = 0; i < model.regions.length; i++) {
  for (let j = i + 1; j < model.regions.length; j++) {
    const a = model.regions[i]!
    const b = model.regions[j]!
    const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
    const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
    if (overlapX > 0 && overlapY > 0) {
      defects.push(
        `regions '${a.id}' and '${b.id}' overlap by ${overlapX.toFixed(2)} x ${overlapY.toFixed(2)} m`,
      )
    }
  }
}

// The cut plane must be inside the hull across every region, or the profile for
// that region is a drawing of the sea. A deep-V hull closes up forward, so a plane
// offset to starboard leaves the hull well before the stem.
for (const r of model.regions) {
  for (const x of [r.x0, (r.x0 + r.x1) / 2, r.x1]) {
    const st = stationAt(form, uFromX(form, x))
    if (CUT_Z > st.sheerZ) {
      defects.push(
        `the cut plane z=${CUT_Z.toFixed(2)} is OUTSIDE the hull at x=${x.toFixed(2)} ` +
          `(sheer half-breadth there is ${st.sheerZ.toFixed(2)} m), so region '${r.id}' is drawn in open water`,
      )
      break
    }
  }
}

// A region must lie inside the hull at the cut plane, or it is in the sea.
for (const r of model.regions) {
  const u = uFromX(form, (r.x0 + r.x1) / 2)
  const bottom = hullBottomY(form, u, CUT_Z)
  const top = hullTopY(form, u)
  if (r.y0 < bottom - 0.05) {
    defects.push(
      `region '${r.id}' starts at y=${r.y0.toFixed(2)} but the hull bottom at the cut plane is y=${bottom.toFixed(2)}`,
    )
  }
  if (r.y1 > top + 0.05) {
    defects.push(
      `region '${r.id}' ends at y=${r.y1.toFixed(2)} but the sheer at that station is y=${top.toFixed(2)}`,
    )
  }
}

// A hatch must lead to a region that exists, and be reachable from where it says.
for (const h of model.hatches) {
  if (!model.regions.some((r) => r.id === h.leadsTo)) {
    defects.push(`hatch '${h.id}' leads to unknown region '${h.leadsTo}'`)
  }
  if (h.from !== 'exterior' && !model.regions.some((r) => r.id === h.from)) {
    defects.push(`hatch '${h.id}' is reached from unknown region '${h.from}'`)
  }
}

// A fault must be in a region that exists, and inside that region.
for (const f of model.faults) {
  const r = model.regions.find((x) => x.id === f.region)
  if (r === undefined) {
    defects.push(`fault '${f.id}' is in unknown region '${f.region}'`)
    continue
  }
  if (f.x < r.x0 || f.x > r.x1 || f.y < r.y0 || f.y > r.y1) {
    defects.push(
      `fault '${f.id}' at (${f.x.toFixed(2)}, ${f.y.toFixed(2)}) is outside region '${r.id}'`,
    )
  }
}

// The section must close: the chine below the sheer, the keel below the chine.
for (const s of form.stations) {
  if (!(s.keelY <= s.chineY && s.chineY <= s.sheerY)) {
    defects.push(
      `section does not close at u=${s.u.toFixed(1)}: keel ${s.keelY.toFixed(2)} chine ${s.chineY.toFixed(2)} sheer ${s.sheerY.toFixed(2)}`,
    )
  }
}

// A void with no hatch and no direct access is a void nothing can reach. That is
// not necessarily wrong — it is the thing the product is about — but it must be
// deliberate.
for (const r of model.regions) {
  if (r.kind !== 'void') continue
  if (model.personReachability.has(r.id)) continue
  const hatches = model.hatches.filter((h) => h.leadsTo === r.id)
  if (hatches.length === 0) {
    defects.push(`void '${r.id}' has no hatch at all and no direct access`)
  }
}

if (defects.length === 0) {
  console.log('  no defects found')
} else {
  for (const d of defects) console.log(`  DEFECT  ${d}`)
}

// --------------------------------------------------------------- assumptions

heading('6. ASSUMPTIONS — none of the above is a measurement')

for (const a of model.assumptions) console.log(`  - ${a}`)

console.log('')
console.log(line('='))
console.log('  Every number above is derived from Sunseeker\'s published principal')
console.log('  characteristics plus assumed profiles. Replace the profiles with the')
console.log('  yard lines plan, and re-run this, before any of it is quoted.')
console.log(line('='))
