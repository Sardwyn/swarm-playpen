/**
 * Content loader and schema validation. Spec §1.1 — content is JSON, validated at
 * load by a test, never a prose blob.
 *
 * The same rule as `mil/` §8 and MEGA F UP §22, and for the same reason: a
 * content bug that reaches the sim looks like a sim bug, and hours go into
 * debugging an integer that was wrong in a file.
 */

import type { Aabb, BoxObstacle, Conduit, Manifold, Port, PortKind, Room , Volume } from '../types.ts'
import type { House } from './geometry.ts'
import { sqrt } from '../math.ts'
import houseJson from '../../content/house-01.json'

const VALID_MANIFOLDS: readonly Manifold[] = ['ground', 'constrained', 'volumetric']
const VALID_PORT_KINDS: readonly PortKind[] = ['vent', 'conduit_entry', 'hatch']

function isAabb(v: unknown): v is Aabb {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  const keys = ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'] as const
  return keys.every((k) => typeof a[k] === 'number' && Number.isFinite(a[k] as number))
}

function validateAabb(aabb: Aabb, where: string): void {
  if (aabb.minX >= aabb.maxX) {
    throw new Error(`${where}: minX >= maxX — degenerate box`)
  }
  if (aabb.minY >= aabb.maxY) {
    throw new Error(`${where}: minY >= maxY — degenerate box`)
  }
  if (aabb.minZ >= aabb.maxZ) {
    throw new Error(`${where}: minZ >= maxZ — degenerate box`)
  }
}

function validateObstacle(o: BoxObstacle, where: string): void {
  if (typeof o.id !== 'string' || o.id.length === 0) {
    throw new Error(`${where}: obstacle needs an id`)
  }
  if (!VALID_MANIFOLDS.includes(o.manifold)) {
    throw new Error(`${where}/${o.id}: unknown manifold '${o.manifold}'`)
  }
  if (!isAabb(o.aabb)) {
    throw new Error(`${where}/${o.id}: aabb must have six finite numbers`)
  }
  validateAabb(o.aabb, `${where}/${o.id}`)
}

function validatePort(p: Port, where: string): void {
  if (typeof p.id !== 'string' || p.id.length === 0) {
    throw new Error(`${where}: port needs an id`)
  }
  if (!VALID_MANIFOLDS.includes(p.a) || !VALID_MANIFOLDS.includes(p.b)) {
    throw new Error(`${where}/${p.id}: port manifolds must be valid`)
  }
  if (p.a === p.b && p.a !== 'ground' && p.a !== 'volumetric') {
    throw new Error(
      `${where}/${p.id}: a ${p.a}->${p.b} port is meaningless — ` +
        `spec §2.4 has manifolds touching only through distinct manifolds`,
    )
  }
  if (!Array.isArray(p.position) || p.position.length !== 3) {
    throw new Error(`${where}/${p.id}: position must be [x,y,z]`)
  }
  if (!(p.radius > 0)) {
    throw new Error(`${where}/${p.id}: radius must be positive`)
  }
  // `kind` is optional and defaults to `vent`, but a *wrong* value would silently
  // disable a detector at that port — the same class of failure as a detector
  // threshold outside its field's range. It is validated rather than trusted.
  if (p.kind !== undefined && !VALID_PORT_KINDS.includes(p.kind)) {
    throw new Error(
      `${where}/${p.id}: unknown port kind '${p.kind}' — ` +
        `valid kinds are ${VALID_PORT_KINDS.join(', ')}`,
    )
  }
  // A conduit entry with nothing in the constrained manifold is a contradiction:
  // the declared purpose is the only thing that stops the blocked-vent detector
  // treating the penetration as an air register.
  if (p.kind === 'conduit_entry' && p.a !== 'constrained' && p.b !== 'constrained') {
    throw new Error(
      `${where}/${p.id}: kind 'conduit_entry' but neither side is the constrained manifold`,
    )
  }
}

/**
 * Validate one conduit.
 *
 * The checks are not defensive boilerplate — each one maps to a way the content
 * could be wrong that the *simulator* would not catch, because the graph would
 * still build and still route:
 *
 * - a centreline point that is not a finite triple makes arc length NaN, and a NaN
 *   arc silently fails every comparison, so the agent stands still forever;
 * - a declared feature outside the conduit can never be reached, which presents
 *   as "loop closure never fires" — a localisation result, not a content bug;
 * - a conduit opening onto a port id that no port declares is exactly the
 *   dangling-reference class that drops records on the floor.
 */
function validateConduit(c: Conduit, where: string, ports: readonly Port[]): void {
  if (typeof c.id !== 'string' || c.id.length === 0) throw new Error(`${where}: conduit needs an id`)
  if (!(c.bore > 0)) throw new Error(`${where}/${c.id}: bore must be positive`)

  if (!Array.isArray(c.points) || c.points.length < 2) {
    throw new Error(`${where}/${c.id}: centreline needs at least two points`)
  }
  c.points.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`${where}/${c.id}: point ${i} must be three finite numbers`)
    }
  })

  // Two identical consecutive points give a zero-length segment, and the
  // arc-length parameterisation divides by it.
  for (let i = 1; i < c.points.length; i++) {
    const a = c.points[i - 1]!
    const b = c.points[i]!
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) {
      throw new Error(`${where}/${c.id}: points ${i - 1} and ${i} are identical — zero-length segment`)
    }
  }

  const portIds = new Set(ports.map((p) => p.id))
  for (const [end, id] of [
    ['startPort', c.startPort],
    ['endPort', c.endPort],
  ] as const) {
    if (id !== undefined && !portIds.has(id)) {
      throw new Error(`${where}/${c.id}: ${end} references unknown port '${id}'`)
    }
  }

  // Total centreline length, computed here so feature arcs can be range-checked
  // against it. `buildLumenGraph` computes the same number independently; if the two
  // ever disagree, one of them is wrong and the graph builder's own check fires.
  let total = 0
  for (let i = 1; i < c.points.length; i++) {
    const a = c.points[i - 1]!
    const b = c.points[i]!
    total += sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2)
  }
  if (total <= 0) {
    throw new Error(`${where}/${c.id}: centreline has zero length`)
  }

  if (!Array.isArray(c.features)) throw new Error(`${where}/${c.id}: features must be an array`)
  for (const [i, f] of c.features.entries()) {
    if (typeof f.arc !== 'number' || !Number.isFinite(f.arc)) {
      throw new Error(`${where}/${c.id}: feature ${i} needs a finite arc`)
    }
    if (f.arc < 0) throw new Error(`${where}/${c.id}: feature ${i} has negative arc`)
    if (typeof f.kind !== 'string' || f.kind.length === 0) {
      throw new Error(`${where}/${c.id}: feature ${i} needs a kind`)
    }
    // Checked here, against the arc length computed from this same centreline,
    // rather than only in `buildLumenGraph`. A landmark past the end can never be
    // reached, which presents as "loop closure never fires" — a localisation
    // result. The same defect also silently voids the drift bound, because a bound
    // computed from unreachable landmarks bounds nothing.
    if (f.arc > total) {
      throw new Error(
        `${where}/${c.id}: feature ${i} ('${f.kind}') sits at arc ${f.arc} but the conduit is only ` +
          `${total.toFixed(3)} m long — it could never be reached`,
      )
    }
  }

  // A loop whose two ports are the same must actually be a loop in the geometry.
  // If `startPort === endPort` but the polyline does not return to its start, the
  // agent crawls the perimeter and the exit it was told exists is not there.
  if (c.startPort !== undefined && c.startPort === c.endPort) {
    const first = c.points[0]!
    const last = c.points[c.points.length - 1]!
    const d = sqrt((last[0] - first[0]) ** 2 + (last[1] - first[1]) ** 2 + (last[2] - first[2]) ** 2)
    if (d > 0.35) {
      throw new Error(
        `${where}/${c.id}: same port at both ends but the centreline does not close ` +
          `(${d.toFixed(2)} m apart) — the agent would have no exit`,
      )
    }
  }
}

export function loadHouse(raw: unknown): House {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('house: expected an object')
  }
  const h = raw as Record<string, unknown>

  if (typeof h.id !== 'string' || h.id.length === 0) throw new Error('house: needs an id')
  if (!isAabb(h.bounds)) throw new Error('house: bounds must be six finite numbers')
  validateAabb(h.bounds as Aabb, 'house/bounds')

  if (!Array.isArray(h.rooms)) throw new Error('house: rooms must be an array')
  const rooms = h.rooms as unknown as Room[]
  rooms.forEach((r, i) => {
    if (typeof r.id !== 'string') throw new Error(`house/rooms[${i}]: needs an id`)
    if (!isAabb(r.aabb)) throw new Error(`house/rooms[${i}]/${r.id}: bad aabb`)
  })

  if (!Array.isArray(h.obstacles)) throw new Error('house: obstacles must be an array')
  const obstacles = h.obstacles as unknown as BoxObstacle[]
  obstacles.forEach((o, i) => validateObstacle(o, `house/obstacles[${i}]`))

  if (!Array.isArray(h.ports)) throw new Error('house: ports must be an array')
  const ports = h.ports as unknown as Port[]
  ports.forEach((p, i) => validatePort(p, `house/ports[${i}]`))


  // Duplicate ids would make every id-keyed lookup silently drop a record.
  assertUniqueIds(rooms.map((r) => r.id), 'room')
  assertUniqueIds(obstacles.map((o) => o.id), 'obstacle')
  assertUniqueIds(ports.map((p) => p.id), 'port')
  assertPortsInBounds({ bounds: h.bounds as Aabb, ports })

  const conduits = Array.isArray(h.conduits) ? (h.conduits as unknown as Conduit[]) : []
  conduits.forEach((c, i) => validateConduit(c, `house/conduits[${i}]`, ports))
  assertUniqueIds(conduits.map((c) => c.id), 'conduit')

  const spawn = h.spawn as { x: number; z: number; theta: number } | undefined
  if (!spawn || typeof spawn.x !== 'number' || typeof spawn.z !== 'number') {
    throw new Error('house: spawn must be {x, z, theta}')
  }

  // Named spaces in the volumetric manifold. Optional: a house has none worth
  // naming and a vessel has two.
  const voids = (Array.isArray(h.voids) ? (h.voids as unknown as Volume[]) : []).map((v, i) => {
    if (typeof v.id !== 'string' || v.id.length === 0) {
      throw new Error(`house/voids[${i}]: needs an id`)
    }
    if (!isAabb(v.aabb)) throw new Error(`house/voids[${i}]/${v.id}: bad aabb`)
    return { id: v.id, name: v.name ?? v.id, aabb: v.aabb }
  })
  assertUniqueIds(voids.map((v) => v.id), 'void')

  return {
    id: h.id,
    name: (h.name as string | undefined) ?? h.id,
    bounds: h.bounds as Aabb,
    rooms,
    obstacles,
    ports,
    docks: (Array.isArray(h.docks) ? h.docks : ports.filter((p) => p.a === 'ground')) as Port[],
    conduits,
    voids,
  }
}

function assertUniqueIds(ids: readonly string[], what: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`house: duplicate ${what} id '${id}' — id-keyed lookups would silently drop one`)
    }
    seen.add(id)
  }
}

/** The Stage A test bed. */
export function loadHouse01(): House {
  return loadHouse(houseJson as unknown)
}

/**
 * Every port must be inside the world. Spec �2.4.
 *
 * ## Why this check exists at all
 *
 * `validatePort` checks *shape*: finite position, positive radius, valid manifolds. It
 * never checked the port against `bounds`, so `shaft-cap-garage` sat at y = 4.0 in a
 * world whose `maxY` was 2.6 for the whole of Stage A-E, declared as a volumetric to
 * volumetric link, and was carried the entire time as a declaration. A route through it
 * would have flown into empty space, and nothing failed.
 *
 * This is the same failure as the 118 K magnitude gate, the dead `checkStuck` that
 * produced a false zero `stranded: 0` for four stages, and the clamped score normalisers
 * that made allocation regret identically 0.00%: **a thing that returns nothing looks
 * exactly like a house with no shaft in it.** The fix is not the deletion - that is
 * recorded as a cut in the spec - it is that the class is now caught at load time.
 *
 * Exported rather than inlined so a negative test can exercise it without constructing
 * an otherwise-valid house with one field broken.
 */
export function assertPortsInBounds(raw: unknown): void {
  const h = raw as { bounds?: Aabb; ports?: readonly Port[] }
  if (!isAabb(h.bounds) || !Array.isArray(h.ports)) return
  const b = h.bounds
  for (const p of h.ports) {
    const pos = (p as Port).position
    if (!Array.isArray(pos) || pos.length !== 3) continue
    const [x, y, z] = pos
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) {
      throw new Error(
        `house/ports/${(p as Port).id}: position [${x}, ${y}, ${z}] is outside house bounds ` +
          `x ${b.minX}..${b.maxX}, y ${b.minY}..${b.maxY}, z ${b.minZ}..${b.maxZ}. ` +
          `A port outside the world cannot be reached, so it is a declaration and not a route.`,
      )
    }
  }
}
