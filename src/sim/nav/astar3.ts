/**
 * Free-flight A* on the volumetric voxel grid. Spec §5.4, Stage F.
 *
 * ## 26-connected, and why the 2-D planner's corner-cut rule does not apply
 *
 * The ground grid is 8-connected and forbids diagonals that cut a corner between two
 * blocked cells, because a 0.34 m turn radius and real mass mean a path through a
 * diagonal gap is not drivable. This planner is **26-connected** and applies no
 * corner-cut rule, and the asymmetry is physical rather than a simplification:
 *
 * - A face diagonal (2 axes) from centre to centre passes through the midpoint of the
 *   shared edge. It touches the two cells on either side of that edge only at a point.
 * - An edge diagonal (3 axes) passes through the shared corner of all eight cells, again
 *   only at a point.
 *
 * A hovercraft can stop and translate in any direction, so a path that grazes a corner
 * is one it can actually fly. Applying the ground bot's rule here would be importing a
 * constraint that belongs to a different vehicle, and would make the hover bot refuse
 * routes it can take.
 *
 * What *does* constrain the body is `volumetricPassability`, which dilates the grid by
 * the rotor radius before this planner ever sees it. Geometry safety lives there; the
 * choice of neighbours lives here.
 *
 * ## Determinism
 *
 * Same guarantees as the 2-D planner, and for the same reasons:
 *
 * - Shared `MinHeap`, so the tie-break is literally the same code. Duplicating the heap
 *   for the second planner is how two implementations of a tie-break drift apart.
 * - Open/closed as arrays; expansion order is a total order on voxel index.
 * - Neighbour order is fixed and enumerated once, below.
 * - No tolerance-driven loops: runs to goal or to exhaustion.
 *
 * The grid is 120 x 36 x 80 = 345,600 voxels, and each search allocates a Float64Array
 * of `g`-scores plus an Int32Array of parents plus a Uint8Array of closed flags — about
 * 4.5 MB. That is fine for a search on job assignment and wasteful per tick, so callers
 * replan when the job changes rather than every tick. Stated here because "it's fine" is
 * what a per-tick replan would have assumed.
 */

import type { VoxelGrid } from '../world/volumetric.ts'
import { VOXEL, voxelIndex, inVoxelBounds, voxelCentreX, voxelCentreY, voxelCentreZ } from '../world/volumetric.ts'
import { MinHeap } from './heap.ts'
import { sqrt } from '../math.ts'

const SQRT2 = 1.4142135623730951
const SQRT3 = 1.7320508075688772

/**
 * Fixed neighbour order: all 26, axis-aligned first, then face diagonals, then edge
 * diagonals, each octant in a fixed sequence. Cost is 1, sqrt2 or sqrt3.
 *
 * The order is arbitrary but it must be *fixed*: neighbour order does not change which
 * cells are reachable, but it does change which parent a cell records when two
 * expansions offer equal `g`, and therefore the exact path returned.
 */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number, number]> = (() => {
  const out: Array<readonly [number, number, number, number]> = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        const cost = dx !== 0 && dy !== 0 && dz !== 0 ? SQRT3 : dx !== 0 && dy !== 0 ? SQRT2 : 1
        out.push([dx, dy, dz, cost])
      }
    }
  }
  return out
})()

export type Path3Result = {
  /** World-space waypoints, start excluded, goal included if reached. */
  readonly points: ReadonlyArray<{ x: number; y: number; z: number }>
  /** True when the goal was expanded. False means a partial path to the closest reachable voxel. */
  readonly reached: boolean
  readonly expanded: number
  /** Cumulative path length in metres. Feeds allocation distance (spec §6.3). */
  readonly length: number
}

function clampIndex(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v
}

/**
 * A* between two world positions in free air.
 *
 * Returns a partial path with `reached: false` rather than throwing, for the same reason
 * the 2-D planner does: "cannot get there" is a normal modelled outcome that the
 * allocator has to reason about, and a job no agent can reach becomes a starvation
 * (spec §6.5). Throwing would turn a modelled outcome into a crash.
 */
export function findPath3(
  grid: VoxelGrid,
  mask: Uint8Array,
  startX: number,
  startY: number,
  startZ: number,
  goalX: number,
  goalY: number,
  goalZ: number,
  maxExpansions = 400_000,
): Path3Result {
  const n = grid.nx * grid.ny * grid.nz

  // ## A goal outside the world has no path, and must not be clamped into one
  //
  // The first version clamped every coordinate into the grid, so a goal at x = 9.0 in a
  // world whose `maxX` is 6.0 was clamped to the last column, found a passable voxel
  // beside it, and reported `reached: true` with a 5.60 m path. That is a lie in the
  // exact sense this project keeps catching: it manufactures a route into something that
  // is not there. Clamping is right for a goal that is *inside* the world but blocked,
  // and wrong for one that is outside it, so the two cases are separated here.
  const rawGx = Math.floor((goalX - grid.minX) / VOXEL)
  const rawGy = Math.floor((goalY - grid.minY) / VOXEL)
  const rawGz = Math.floor((goalZ - grid.minZ) / VOXEL)
  if (
    rawGx < 0 ||
    rawGx >= grid.nx ||
    rawGy < 0 ||
    rawGy >= grid.ny ||
    rawGz < 0 ||
    rawGz >= grid.nz
  ) {
    return { points: [], reached: false, expanded: 0, length: 0 }
  }

  const sx = clampIndex(Math.floor((startX - grid.minX) / VOXEL), grid.nx)
  const sy = clampIndex(Math.floor((startY - grid.minY) / VOXEL), grid.ny)
  const sz = clampIndex(Math.floor((startZ - grid.minZ) / VOXEL), grid.nz)
  const gx = rawGx
  const gy = rawGy
  const gz = rawGz

  const start = voxelIndex(grid, sx, sy, sz)
  const goal = voxelIndex(grid, gx, gy, gz)

  // A goal that is inside the world but blocked — a job authored inside a wall — gets the
  // nearest passable voxel, and `reached` stays **false**. See below.
  const goalOpen = mask[goal] === 1
  const target = goalOpen ? goal : nearestOpen(grid, mask, gx, gy, gz)

  const gScore = new Float64Array(n).fill(Number.POSITIVE_INFINITY)
  const cameFrom = new Int32Array(n).fill(-1)
  const closed = new Uint8Array(n)

  const cx0 = target % grid.nx
  const cy0 = (target - cx0) / grid.nx
  const cz0 = (cy0 - (cy0 % grid.ny)) / grid.ny
  const ty = cy0 % grid.ny

  const h = (index: number): number => {
    const ix = index % grid.nx
    const iy = (index - ix) / grid.nx % grid.ny
    const iz = Math.floor((index - ix) / grid.nx / grid.ny)
    const dx = ix - cx0
    const dy = iy - ty
    const dz = iz - cz0
    return sqrt(dx * dx + dy * dy + dz * dz) * VOXEL
  }

  if (mask[start] !== 1) {
    // Starting in solid geometry is a bug in the caller's spawn logic, but reporting it
    // as an unreachable goal is more useful than throwing from inside a planner.
    return { points: [], reached: false, expanded: 0, length: 0 }
  }

  gScore[start] = 0
  const open = new MinHeap(n)
  open.push(start, h(start))

  let expanded = 0
  let end = -1

  for (;;) {
    if (open.length === 0) break
    const current = open.pop()
    if (closed[current] === 1) continue
    closed[current] = 1
    expanded++

    if (current === target) {
      end = current
      break
    }
    if (expanded >= maxExpansions) break

    const ix = current % grid.nx
    const iy = (current - ix) / grid.nx % grid.ny
    const iz = Math.floor((current - ix) / grid.nx / grid.ny)

    for (const [dx, dy, dz, cost] of NEIGHBOURS) {
      const nx = ix + dx
      const ny = iy + dy
      const nz = iz + dz
      if (!inVoxelBounds(grid, nx, ny, nz)) continue
      const ni = voxelIndex(grid, nx, ny, nz)
      if (closed[ni] === 1) continue
      // Destination-only test — see the file header on why there is no corner-cut rule.
      if (mask[ni] !== 1) continue

      const tentative = gScore[current]! + cost * VOXEL
      if (tentative < gScore[ni]!) {
        gScore[ni] = tentative
        cameFrom[ni] = current
        open.push(ni, tentative + h(ni))
      }
    }
  }

  if (end < 0) {
    // Exhausted. Report the best closed node by remaining distance, so a caller that
    // cannot reach the goal still gets to move somewhere sensible rather than nothing.
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
    if (best < 0) return { points: [], reached: false, expanded, length: 0 }
    return reconstruct3(grid, cameFrom, best, expanded, false)
  }

  // `reached` means the goal voxel itself was expanded — nothing weaker. When the goal was
  // blocked and `nearestOpen` substituted a neighbour, the bot ends up beside the job and
  // not at it, and the arrival test in the run loop keys off this flag. Reporting true
  // there would let a job inside a wall be marked complete on arrival next door.
  return reconstruct3(grid, cameFrom, end, expanded, goalOpen && end === goal)
}

/**
 * Nearest passable voxel to a blocked goal, by expanding rings outward.
 *
 * Ring order rather than a minimum over the whole grid: the nearest passable voxel is
 * almost always in the first ring or two, and scanning 345,600 voxels to find it would
 * dominate the cost of a search that usually succeeds. Rings are enumerated in fixed
 * offset order so the answer does not depend on iteration luck.
 */
function nearestOpen(grid: VoxelGrid, mask: Uint8Array, gx: number, gy: number, gz: number): number {
  const maxR = Math.max(grid.nx, grid.ny, grid.nz)
  for (let r = 1; r <= maxR; r++) {
    let best = -1
    let bestD = Number.POSITIVE_INFINITY
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          // Only the shell of this ring, in a fixed order.
          if (Math.abs(dx) !== r && Math.abs(dy) !== r && Math.abs(dz) !== r) continue
          const nx = gx + dx
          const ny = gy + dy
          const nz = gz + dz
          if (!inVoxelBounds(grid, nx, ny, nz)) continue
          const ni = voxelIndex(grid, nx, ny, nz)
          if (mask[ni] !== 1) continue
          const d = dx * dx + dy * dy + dz * dz
          if (d < bestD) {
            bestD = d
            best = ni
          }
        }
      }
    }
    if (best >= 0) return best
  }
  return -1
}

function reconstruct3(
  grid: VoxelGrid,
  cameFrom: Int32Array,
  end: number,
  expanded: number,
  reached: boolean,
): Path3Result {
  const chain: number[] = []
  let cur = end
  let guard = 0
  while (cur !== -1 && guard++ <= grid.cells.length) {
    chain.push(cur)
    cur = cameFrom[cur]!
  }
  chain.reverse()

  // Start is chain[0] and is excluded from the waypoint list, matching the 2-D planner:
  // the caller already knows where it is, and emitting the start makes the first
  // "move" a zero-length step that the arrival test would count as arrival.
  const points: Array<{ x: number; y: number; z: number }> = []
  for (let i = 1; i < chain.length; i++) {
    const idx = chain[i]!
    const ix = idx % grid.nx
    const iy = (idx - ix) / grid.nx % grid.ny
    const iz = Math.floor((idx - ix) / grid.nx / grid.ny)
    points.push({ x: voxelCentreX(grid, ix), y: voxelCentreY(grid, iy), z: voxelCentreZ(grid, iz) })
  }

  let length = 0
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1]!
    const b = chain[i]!
    const ax = a % grid.nx
    const ay = (a - ax) / grid.nx % grid.ny
    const az = Math.floor((a - ax) / grid.nx / grid.ny)
    const bx = b % grid.nx
    const by = (b - bx) / grid.nx % grid.ny
    const bz = Math.floor((b - bx) / grid.nx / grid.ny)
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    length += sqrt(dx * dx + dy * dy + dz * dz) * VOXEL
  }

  return { points, reached, expanded, length }
}