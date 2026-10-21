/**
 * The vessel, in plain text: the inboard profile and the access arithmetic.
 *
 * ## Why this exists alongside the 3-D scene
 *
 * The scene is for showing somebody. This is for checking, and for reading in a
 * commit. A profile that only exists as a picture is a picture nobody can diff, and
 * the numbers behind it are the ones that matter.
 *
 * ## The access arithmetic
 *
 * The claim the whole domain turns on is arithmetic, and it is short:
 *
 *   deck hatch clear width        200 mm
 *   ground bot across             340 mm   (radius 0.17 m)
 *   hover bot rotor span          240 mm, and it needs 400 mm of clearance
 *   inchworm                      80 mm, but confined to conduits
 *   a person                      can get through a 200 mm hatch
 *
 * So the void is unreachable by the swarm, and a person can reach it. That is the
 * product statement, and it is four numbers long.
 *
 * Run: `npm run diag:yacht`
 */

import {
  yachtHouse,
  yachtPrincipal,
  yachtForm,
  yachtAssumptions,
  YACHT_INCHWORM_HOME,
} from '../src/sim/world/yacht-sim.ts'
import { hullBottomY, stationAt } from '../src/sim/world/yacht-form.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../src/sim/types.ts'

const CUT_Z = 0.65
const COLS = 132
const ROWS = 42

function head(t: string): void {
  console.log('')
  console.log(t)
  console.log('-'.repeat(78))
}

head('PRINCIPAL')
console.log(`  ${yachtPrincipal.source}`)
console.log(
  `  LOA ${yachtPrincipal.loa} m   beam ${yachtPrincipal.beam} m   ` +
    `draft ${yachtPrincipal.draft} m   displacement ${yachtPrincipal.displacementKg} kg`,
)

head('STATIONS')
console.log(['   u', '      x', '  keelY', ' chineY', ' sheerY', ' dr°'].join('  '))
for (const s of yachtForm.stations) {
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

head(`INBOARD PROFILE at z = ${CUT_Z.toFixed(2)} m (starboard of centreline)`)

const maxY = Math.max(...yachtForm.stations.map((s) => s.sheerY))
const x0 = -yachtPrincipal.loa / 2
const x1 = yachtPrincipal.loa / 2

const rows: string[] = []
for (let r = ROWS - 1; r >= 0; r--) {
  const y = (r / (ROWS - 1)) * maxY
  const line: string[] = []
  for (let c = 0; c < COLS; c++) {
    const x = x0 + (c / (COLS - 1)) * (x1 - x0)
    const u = (x - x0) / (x1 - x0)
    const bottom = hullBottomY(yachtForm, u, CUT_Z)
    const top = stationAt(yachtForm, u).sheerY
    if (y > top) line.push(' ')
    else if (y > bottom) line.push('.')
    else if (Math.abs(y - bottom) < 0.07 || Math.abs(y - top) < 0.07) line.push('#')
    else line.push(':')
  }
  rows.push(line.join(''))
}

const overlay = (ch: string, x: number, y: number): void => {
  const c = Math.round(((x - x0) / (x1 - x0)) * (COLS - 1))
  const r = Math.round((y / maxY) * (ROWS - 1))
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return
  const row = rows[ROWS - 1 - r]!
  rows[ROWS - 1 - r] = row.slice(0, c) + ch + row.slice(c + 1)
}

// The engine room, the two volumes above it, and the access points.
const voids = yachtHouse.voids
for (const v of voids) {
  const cx = (v.aabb.minX + v.aabb.maxX) / 2
  const cy = v.aabb.maxY + 0.35
  overlay(v.id === 'stringer-fwd' ? 'X' : 'V', cx, cy)
}
for (const p of yachtHouse.ports) {
  if (p.kind !== 'hatch') continue
  overlay('H', p.position[0], p.position[1])
}

console.log('   ' + ' '.repeat(COLS))
for (const row of rows) console.log('   ' + row)
console.log('   ' + ' '.repeat(COLS))
console.log('   X stringer void (the one the swarm cannot reach)   V deckhead void   H access point')

head('THE ACCESS ARITHMETIC')
const hatch = yachtHouse.ports.find((p) => p.kind === 'hatch')
const clearMm = hatch === undefined ? 0 : Math.round(hatch.radius * 2000)
console.log(`  deck hatch clear width         ${clearMm} mm`)
console.log(`  ground bot across              ${Math.round(GROUND_BOT.radius * 2000)} mm`)
// The hover bot's clearance is a voxel count, not a distance: the volumetric
// passability mask wants `radiusCells * 2` cells of clearance, and a cell is
// 0.1 m. Two cells of radius, doubled, is 0.4 m — which is more than the void
// it would have to fly in.
const hoverClearanceM = Math.ceil(HOVER.radius / 0.1) * 2 * 0.1
console.log(
  `  hover bot rotor span           ${Math.round(HOVER.radius * 2000)} mm, ` +
    `needs ${hoverClearanceM.toFixed(2)} m of clearance`,
)
console.log(`  inchworm                       ${Math.round(INCHWORM.radius * 2000)} mm, but confined to conduits`)
console.log(`  a person                       can get through a ${clearMm} mm hatch`)
console.log('')
console.log(
  `  so the stringer void is unreachable by the swarm, and a person can reach it.`,
)
console.log(`  the crawler's home port is '${YACHT_INCHWORM_HOME}'.`)

head('THE CONTENT')
console.log(`  rooms      ${yachtHouse.rooms.map((r) => r.id).join(', ')}`)
console.log(`  voids      ${voids.map((v) => v.id).join(', ')}`)
console.log(`  obstacles  ${yachtHouse.obstacles.length}`)
console.log(`  conduits   ${yachtHouse.conduits.map((c) => `${c.id} (bore ${c.bore} m)`).join(', ')}`)
console.log(`  ports      ${yachtHouse.ports.length}`)

head('ASSUMPTIONS — none of the above is a measurement')
for (const a of yachtAssumptions) console.log(`  - ${a}`)
