/**
 * A* on the ground occupancy grid.
 *
 * Deterministic by construction, which is the whole requirement here (spec §1.4):
 *
 * - Open and closed sets are binary heaps keyed on (f, index). Ties break on the
 *   lower cell index, so the expansion order is a total order on indices and
 *   cannot depend on insertion order or heap internals.
 * - No tolerance-driven loops. The search runs to exhaustion or to goal.
 * - Neighbour order is fixed: N, NE, E, SE, S, SW, W, NW.
 *
 * The tie-break is not cosmetic. Two cells with equal f expanded in
 * heap-arrival order is exactly the kind of order dependence that passes on one
 * machine and produces a different path on another.
 */

import type { Grid } from '../world/geometry.ts'
import { CELL, gridIndex, inBounds, cellCenterX, cellCenterZ } from '../world/geometry.ts'
import { MinHeap } from './heap.ts'
import { abs, sqrt } from '../math.ts'

const SQRT2 = 1.4142135623730951


/** Fixed neighbour order: N, NE, E, SE, S, SW, W, NW. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 1],
  [1, -1, SQRT2],
  [1, 0, 1],
  [1, 1, SQRT2],
  [0, 1, 1],
  [-1, 1, SQRT2],
  [-1, 0, 1],
  [-1, -1, SQRT2],
]

export type PathResult = {
  /** World-space waypoints, start excluded, goal included if reached. */
  readonly points: ReadonlyArray<{ x: number; z: number }>
  /** True when the goal was expanded. False means partial path to the closest reachable cell. */
  readonly reached: boolean
  readonly expanded: number
  /** Cumulative path length, metres. Feeds allocation distance (spec §6.3). */
  readonly length: number
}

/**
 * A* between two world positions.
 *
 * Returns a partial path with `reached: false` rather than failing outright,
 * because "cannot get there" is a normal condition that the allocator must
 * reason about (a job no agent can reach becomes a starvation, spec §6.5) and
 * throwing would turn a modelled outcome into a crash.
 */
export function findPath(
  g: Grid,
  mask: Uint8Array,
  startX: number,
  startZ: number,
  goalX: number,
  goalZ: number,
  maxExpansions = 200_000,
): PathResult {
  const n = g.width * g.height

  const sx = Math.floor((startX - g.minX) / CELL)
  const sz = Math.floor((startZ - g.minZ) / CELL)

  if (!inBounds(g, sx, sz)) {
    return { points: [], reached: false, expanded: 0, length: 0 }
  }

  // ## A goal outside the world has no path, and must not be clamped into one
  //
  // Stage F found this in the 3-D planner and it belongs here too: clamping an
  // out-of-world goal into the grid, finding a passable cell beside it, and reporting
  // `reached: true` manufactures a route into something that is not there. Jobs are
  // currently only ever placed inside `bounds`, so this is latent rather than live —
  // which is exactly why it needs a guard instead of an assumption. `reached` means the
  // goal cell was expanded, nothing weaker, so a job authored inside a wall is reported
  // as a partial path and the arrival test will not fire on it.
  const rawGx = Math.floor((goalX - g.minX) / CELL)
  const rawGz = Math.floor((goalZ - g.minZ) / CELL)
  if (rawGx < 0 || rawGx >= g.width || rawGz < 0 || rawGz >= g.height) {
    return { points: [], reached: false, expanded: 0, length: 0 }
  }

  // If the goal itself is blocked, aim at the nearest passable cell to it.
  // Handled by relaxing the goal test below rather than by a separate search:
  // cheaper, and it produces the right behaviour for "job is inside a wall".
  let gx = rawGx
  let gz = rawGz

  const start = sz * g.width + sx
  const goal = gz * g.width + gx

  const gScore = new Float64Array(n).fill(Number.POSITIVE_INFINITY)
  const cameFrom = new Int32Array(n).fill(-1)
  const closed = new Uint8Array(n)

  const h = (index: number): number => {
    const cx = index % g.width
    const cz = (index - cx) / g.width
    const dx = abs(cx - gx)
    const dz = abs(cz - gz)
    // Octile distance: exact for 8-connected grids with diagonals costing sqrt2.
    return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * CELL
  }

  gScore[start] = 0
  const open = new MinHeap(n)
  open.push(start, h(start))

  let expanded = 0

  for (;;) {
    if (open.length === 0) break

    const current = open.pop()
    if (closed[current] === 1) continue
    closed[current] = 1
    expanded++

    if (current === goal) {
      return reconstruct(g, cameFrom, current, start, true, expanded)
    }

    if (expanded >= maxExpansions) break

    const cx = current % g.width
    const cz = (current - cx) / g.width

    for (const [dx, dz, cost] of NEIGHBOURS) {
      const nx = cx + dx
      const nz = cz + dz
      if (!inBounds(g, nx, nz)) continue
      const ni = nz * g.width + nx
      if (closed[ni] === 1) continue
      // Diagonals may not cut a corner between two blocked cells. Without this
      // the robot plans paths that physically cannot be driven.
      if (dx !== 0 && dz !== 0) {
        if (mask[cz * g.width + nx] !== 1) continue
        if (mask[nz * g.width + cx] !== 1) continue
      }
      if (mask[ni] !== 1) continue

      const tentative = gScore[current]! + cost * CELL
      if (tentative < gScore[ni]!) {
        gScore[ni] = tentative
        cameFrom[ni] = current
        open.push(ni, tentative + h(ni))
      }
    }
  }

  // Exhausted. Report the best closed node by remaining distance to goal.
  let best = -1
  let bestH = Number.POSITIVE_INFINITY
  for (let i = 0; i < n; i++) {
    if (closed[i] !== 1) continue
    const hv = h(i)
    if (hv < bestH) {
      bestH = hv
      best = i
    }
  }
  if (best < 0) {
    return { points: [], reached: false, expanded, length: 0 }
  }
  return reconstruct(g, cameFrom, best, start, false, expanded)
}

function reconstruct(
  g: Grid,
  cameFrom: Int32Array,
  end: number,
  start: number,
  reached: boolean,
  expanded: number,
): PathResult {
  const chain: number[] = []
  let node = end
  // Bounded by the cell count; a malformed cameFrom would otherwise spin.
  for (let guard = 0; guard <= g.width * g.height; guard++) {
    chain.push(node)
    if (node === start) break
    const prev = cameFrom[node]!
    if (prev < 0) break
    node = prev
  }
  chain.reverse()

  const points: Array<{ x: number; z: number }> = []
  let length = 0
  for (let i = 1; i < chain.length; i++) {
    const cx = chain[i]! % g.width
    const cz = (chain[i]! - cx) / g.width
    const px = cellCenterX(g, cx)
    const pz = cellCenterZ(g, cz)
    if (points.length > 0) {
      const last = points[points.length - 1]!
      length += sqrt((px - last.x) * (px - last.x) + (pz - last.z) * (pz - last.z))
    }
    points.push({ x: px, z: pz })
  }

  return { points, reached, expanded, length }
}

/** Straight-line distance, as an optimistic lower bound on path distance. */
export function euclidean(x1: number, z1: number, x2: number, z2: number): number {
  return sqrt((x2 - x1) * (x2 - x1) + (z2 - z1) * (z2 - z1))
}

export { gridIndex }
