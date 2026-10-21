/**
 * House geometry and the ground occupancy grid.
 *
 * Stage A scope: the ground manifold only. Constrained and volumetric manifolds
 * are Stage E/F, and the manifold modules exist as stubs in `manifolds.ts` so
 * the port graph has somewhere to point.
 *
 * The grid is the ground bot's world model AND the navigation substrate. It is
 * one structure serving both purposes deliberately: an agent that navigates a
 * map and an agent that builds a map must face the same obstacles, or the
 * coverage metric measures something the robot never had to solve.
 */

import type { Aabb, BoxObstacle, Conduit, Manifold, Port, Room } from '../types.ts'
import { abs, floor } from '../math.ts'

/** Spec §10: GRID_CELL 0.05 m. */
export const CELL = 0.05

/** Grid cell states. Order matters: comparisons use `<= FREE`. */
export const CELL_UNKNOWN = 0
export const CELL_FREE = 1
export const CELL_OCCUPIED = 2
/** Blocked but known — an obstacle seen from a distance, not touched. */
export const CELL_BLOCKED = 3

export type Grid = {
  readonly minX: number
  readonly minZ: number
  readonly width: number
  readonly height: number
  readonly cells: Uint8Array
  /** Bumped per observation, NAVIGABLE cells only. Coverage and frontier logic. */
  readonly observedCount: Uint32Array
  /**
   * Bumped per observation, NON-NAVIGABLE cells only: walls, furniture, fissures.
   *
   * **Deliberately separate from `observedCount`.** These are different facts —
   * "the floor here is navigable and I have seen it" versus "I have seen this
   * surface" — and merging them into one array quietly broke the frontier logic
   * that drives coverage, because a cell beside a wall then counted as touching
   * known space and the explorer followed the wall instead of opening up the room.
   * Measured: coverage fell from 100% to 68% within one change.
   */
  readonly surfaceCount: Uint32Array
}

export function createGrid(minX: number, minZ: number, widthM: number, depthM: number): Grid {
  const width = Math.ceil(widthM / CELL)
  const height = Math.ceil(depthM / CELL)
  return {
    minX,
    minZ,
    width,
    height,
    cells: new Uint8Array(width * height),
    observedCount: new Uint32Array(width * height),
    surfaceCount: new Uint32Array(width * height),
  }
}

export function gridIndex(g: Grid, cx: number, cz: number): number {
  return cz * g.width + cx
}

export function inBounds(g: Grid, cx: number, cz: number): boolean {
  return cx >= 0 && cz >= 0 && cx < g.width && cz < g.height
}

export function worldToCellX(g: Grid, x: number): number {
  return floor((x - g.minX) / CELL)
}

export function worldToCellZ(g: Grid, z: number): number {
  return floor((z - g.minZ) / CELL)
}

export function cellCenterX(g: Grid, cx: number): number {
  return g.minX + (cx + 0.5) * CELL
}

export function cellCenterZ(g: Grid, cz: number): number {
  return g.minZ + (cz + 0.5) * CELL
}

export function cellAt(g: Grid, cx: number, cz: number): number {
  if (!inBounds(g, cx, cz)) return CELL_OCCUPIED
  return g.cells[gridIndex(g, cx, cz)]!
}

export function isTraversable(state: number): boolean {
  return state === CELL_FREE
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

/**
 * Stamp an axis-aligned box into the grid as OCCUPIED.
 *
 * Non-blocking obstacles are stamped BLOCKED rather than OCCUPIED, so the
 * coverage metric can distinguish "the robot could not have gone here" from "the
 * robot went here and found a wall". Conflating those is how a coverage figure
 * quietly stops meaning anything.
 */
export function stampBox(g: Grid, o: BoxObstacle): void {
  if (o.manifold !== 'ground') return

  const cx0 = worldToCellX(g, o.aabb.minX)
  const cx1 = worldToCellX(g, o.aabb.maxX)
  const cz0 = worldToCellZ(g, o.aabb.minZ)
  const cz1 = worldToCellZ(g, o.aabb.maxZ)

  // Inflate by the agent radius at call time via `inflate`, not here — the grid
  // is a shared world model, not a per-agent inflated map.
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!inBounds(g, cx, cz)) continue
      g.cells[gridIndex(g, cx, cz)] = o.blocking ? CELL_OCCUPIED : CELL_BLOCKED
    }
  }
}

/**
 * Mark cells free. Anything not stamped by an obstacle and not already observed
 * occupied is floor, which is what a house is: solid where something is, open
 * where nothing is.
 */
export function fillFreeSpace(g: Grid): void {
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] === CELL_UNKNOWN) g.cells[i] = CELL_FREE
  }
}

/**
 * Inflate OCCUPIED cells by an agent radius, producing a passability mask.
 *
 * Uses a two-pass Chebyshev-style distance transform rather than stamping a
 * disc per obstacle: one pass of O(n) regardless of obstacle count, and no
 * dependence on the order obstacles were stamped in — which matters, because
 * spec §1.4 forbids order-dependent results.
 */
export function passabilityMask(g: Grid, radiusCells: number): Uint8Array {
  const n = g.width * g.height
  // Float64Array + Infinity, NOT an Int32Array with a 0x7fffffff sentinel.
  //
  // An int sentinel overflows on the very first relaxation step
  // (`sentinel + 2` wraps negative), which silently poisons the entire distance
  // transform. The symptom is a mask where almost nothing is passable, which
  // looks like a geometry problem and is not one.
  const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY)

  for (let i = 0; i < n; i++) {
    if (g.cells[i] === CELL_OCCUPIED) dist[i] = 0
  }

  // Forward pass: 4-neighbour chamfer.
  for (let cz = 0; cz < g.height; cz++) {
    for (let cx = 0; cx < g.width; cx++) {
      const i = cz * g.width + cx
      let d = dist[i]!
      if (cx > 0) d = Math.min(d, dist[i - 1]! + 2)
      if (cz > 0) d = Math.min(d, dist[i - g.width]! + 2)
      if (cx > 0 && cz > 0) d = Math.min(d, dist[i - g.width - 1]! + 3)
      if (cx < g.width - 1 && cz > 0) d = Math.min(d, dist[i - g.width + 1]! + 3)
      dist[i] = d
    }
  }
  // Backward pass.
  for (let cz = g.height - 1; cz >= 0; cz--) {
    for (let cx = g.width - 1; cx >= 0; cx--) {
      const i = cz * g.width + cx
      let d = dist[i]!
      if (cx < g.width - 1) d = Math.min(d, dist[i + 1]! + 2)
      if (cz < g.height - 1) d = Math.min(d, dist[i + g.width]! + 2)
      if (cx < g.width - 1 && cz < g.height - 1) d = Math.min(d, dist[i + g.width + 1]! + 3)
      if (cx > 0 && cz < g.height - 1) d = Math.min(d, dist[i + g.width - 1]! + 3)
      dist[i] = d
    }
  }

  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    // `dist` is the distance TO the nearest obstacle, so a cell is passable when
    // it is FAR ENOUGH from one — `>=`, not `<=`.
    //
    // Chamfer units are 2 per cell, hence the *2.
    //
    // The occupied test is belt-and-braces: an occupied cell has distance 0 and
    // would already fail a `>= 8` test for a 4-cell radius, but stating it
    // keeps the mask correct if someone calls this with radius 0.
    mask[i] = g.cells[i] !== CELL_OCCUPIED && dist[i]! >= radiusCells * 2 ? 1 : 0
  }
  return mask
}

// ---------------------------------------------------------------------------
// Coverage. Spec §9.1
// ---------------------------------------------------------------------------

export type Coverage = {
  /** Observed navigable cells over total navigable cells. */
  readonly observedFraction: number
  readonly observedCells: number
  readonly totalCells: number
}

/**
 * Coverage over cells the agent could actually have reached.
 *
 * `requiredObservation` is the number of sightings that count as covered. Set
 * above 1 so a cell glimpsed once in a doorway does not count — spec §9.1's
 * resolution requirement, and the difference between coverage and a count of
 * cells that were technically in a sensor cone.
 */
export function coverage(g: Grid, mask: Uint8Array, requiredObservation = 2): Coverage {
  let total = 0
  let observed = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue
    total++
    if (g.observedCount[i]! >= requiredObservation) observed++
  }
  return {
    observedFraction: total === 0 ? 1 : observed / total,
    observedCells: observed,
    totalCells: total,
  }
}

/** Cells never observed, as world-space positions. Drives the report's §8.2 gap list. */
export function uncoveredCells(
  g: Grid,
  mask: Uint8Array,
  requiredObservation = 2,
  limit = 512,
): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = []
  for (let i = 0; i < mask.length && out.length < limit; i++) {
    if (mask[i] !== 1) continue
    if (g.observedCount[i]! >= requiredObservation) continue
    const cx = i % g.width
    const cz = (i - cx) / g.width
    out.push({ x: cellCenterX(g, cx), z: cellCenterZ(g, cz) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Ray casting, for the depth sensor. Spec §4.1
// ---------------------------------------------------------------------------

/**
 * Cast a 2-D ray across the grid via DDA, returning the distance to the first
 * blocking cell.
 *
 * Bounded by `maxRange` and by the grid edge. The edge terminates the ray rather
 * than returning infinity: an unterminated ray makes the agent believe there is
 * structure at infinity, which is a real failure mode in sensor sims.
 */
export function castRay(
  g: Grid,
  mask: Uint8Array,
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  maxRange: number,
): number {
  let cx = worldToCellX(g, x)
  let cz = worldToCellZ(g, z)

  const stepX = dirX > 0 ? 1 : -1
  const stepZ = dirZ > 0 ? 1 : -1

  const invDx = dirX === 0 ? Infinity : 1 / abs(dirX)
  const invDz = dirZ === 0 ? Infinity : 1 / abs(dirZ)

  const cellMinX = g.minX + cx * CELL
  const cellMinZ = g.minZ + cz * CELL

  const tDeltaX = invDx * CELL
  const tDeltaZ = invDz * CELL

  const nextBoundX = cellMinX + (dirX > 0 ? CELL : 0)
  const nextBoundZ = cellMinZ + (dirZ > 0 ? CELL : 0)

  let tMaxX = dirX === 0 ? Infinity : (nextBoundX - x) * (dirX > 0 ? invDx : -invDx)
  let tMaxZ = dirZ === 0 ? Infinity : (nextBoundZ - z) * (dirZ > 0 ? invDz : -invDz)

  let travelled = 0
  // Bounded so a degenerate direction cannot spin. The bound is generous relative
  // to any real ray in a 12 m house.
  const maxSteps = g.width + g.height + 8

  for (let step = 0; step < maxSteps; step++) {
    if (!inBounds(g, cx, cz)) return Math.min(travelled, maxRange)

    // A blocking cell that is not the cell we start in stops the ray. The start
    // cell is exempt so an agent standing against a wall does not read 0 range.
    if (!(cx === worldToCellX(g, x) && cz === worldToCellZ(g, z))) {
      if (mask[gridIndex(g, cx, cz)] !== 1) return Math.min(travelled, maxRange)
    }

    if (tMaxX < tMaxZ) {
      travelled = tMaxX
      cx += stepX
      tMaxX += tDeltaX
    } else {
      travelled = tMaxZ
      cz += stepZ
      tMaxZ += tDeltaZ
    }
    if (travelled >= maxRange) return maxRange
  }
  return maxRange
}

/** Number of rays in a full 360-degree scan. Spec §4.1 depth budget. */
export const DEPTH_RAYS = 360

/**
 * Mark cells as observed along a ray's path, up to the hit distance.
 *
 * Navigable cells bump `observedCount` (coverage, spec §9.1); non-navigable ones
 * bump `surfaceCount` (geometry detectors). See `Grid.surfaceCount` for why these
 * are separate arrays.
 *
 * Returns the number of newly-observed *navigable* cells, which is what the
 * coverage metric consumes.
 */
export function markRayObservation(
  g: Grid,
  mask: Uint8Array,
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  distance: number,
): number {
  let newlyNavigable = 0
  const step = CELL * 0.5
  const steps = Math.floor(distance / step)
  for (let s = 1; s <= steps; s++) {
    const px = x + dirX * s * step
    const pz = z + dirZ * s * step
    const cx = worldToCellX(g, px)
    const cz = worldToCellZ(g, pz)
    if (!inBounds(g, cx, cz)) continue
    newlyNavigable += markCell(g, mask, cx, cz)
  }

  // **The hit cell itself.** `castRay` returns the distance at which the ray
  // *enters* the blocking cell, so the last sample above always lands in the
  // cell before it and the surface is never seen. Without this line every
  // occupied cell stays at zero surface observations forever, which makes every
  // geometry detector blind — the crack proxy found nothing and the pest proxy
  // had no obstructions to reason about, and both reported a plausible 0.00
  // rather than an error.
  const hcx = worldToCellX(g, x + dirX * (distance + CELL * 0.5))
  const hcz = worldToCellZ(g, z + dirZ * (distance + CELL * 0.5))
  if (inBounds(g, hcx, hcz)) {
    newlyNavigable += markCell(g, mask, hcx, hcz)
  }

  return newlyNavigable
}

function markCell(g: Grid, mask: Uint8Array, cx: number, cz: number): number {
  const i = gridIndex(g, cx, cz)
  if (mask[i] === 1) {
    const wasNew = g.observedCount[i] === 0
    g.observedCount[i] = g.observedCount[i]! + 1
    return wasNew ? 1 : 0
  }
  g.surfaceCount[i] = g.surfaceCount[i]! + 1
  return 0
}

// ---------------------------------------------------------------------------
// House
// ---------------------------------------------------------------------------

export type House = {
  readonly id: string
  readonly name: string
  readonly bounds: Aabb
  readonly rooms: readonly Room[]
  readonly obstacles: readonly BoxObstacle[]
  readonly ports: readonly Port[]
  readonly docks: readonly Port[]
  /**
   * Conduits on the constrained manifold. Spec §2.2, Stage E.
   *
   * Optional in content: a house with no pipes is a valid house, and requiring
   * the field would put Stage E's geometry into every Stage A fixture.
   */
  readonly conduits: readonly Conduit[]
}

/**
 * Build the ground grid for a house.
 *
 * Order is fixed and explicit: stamp obstacles, then fill free space, then
 * nothing. Filling before stamping would let a later obstacle overwrite a
 * correctly-rasterised neighbour, and the result would depend on authoring
 * order in the JSON — a content bug that looks like a sim bug.
 */
export function buildGroundGrid(house: House): Grid {
  const g = createGrid(house.bounds.minX, house.bounds.minZ, house.bounds.maxX - house.bounds.minX, house.bounds.maxZ - house.bounds.minZ)

  for (const o of house.obstacles) {
    stampBox(g, o)
  }
  fillFreeSpace(g)
  return g
}

/** Ground bot radius 0.17 m half-width, inflated by one cell of margin. */
export function groundPassability(g: Grid): Uint8Array {
  return passabilityMask(g, Math.ceil(0.17 / CELL))
}

export function manifoldId(m: Manifold): string {
  return m
}