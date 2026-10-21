/**
 * Volumetric occupancy. Spec §5.4, Stage F.
 *
 * ## Why this is a separate grid and not a slice of the ground one
 *
 * The ground grid is 2-D: `minX`, `minZ`, and a single layer. The volumetric manifold
 * needs three, because the whole point of the manifold is that **height is a degree of
 * freedom** — a hover bot goes over a table that stops a ground bot, and under a
 * soffit that stops nothing. Slicing the ground grid into layers would work and would
 * be a lie in a specific way: it would make the layers independent, so a bot could
 * "teleport" between heights through a ceiling that exists in another layer.
 *
 * Voxel edge is **0.10 m**, per spec §5.4. At 0.10 m the grid for this house is
 * 120 × 36 × 80 = 345,600 cells, which is 346 KB as a `Uint8Array`. That is affordable
 * and it is the resolution the *clearance* argument needs: the hover bot's ceiling
 * clearance is 1.0 m, so the grid has to resolve a 0.9 m headroom as distinct from a
 * 1.0 m one. At the ground grid's 0.05 m that would be 8× the memory for nothing.
 *
 * ## Free space is the bounds minus obstacles, and that had to match the 2-D model
 *
 * The first version made free space the **union of room AABBs**. It was wrong, and
 * measurably so: it produced **six disconnected components, one per room**, because
 * rooms do not overlap at their doorways. Every doorway probe returned `VOXEL_OUTSIDE` —
 * the gap between two rooms is in neither room — so each room was sealed inside its own
 * walls and the hover bot could not leave the hall.
 *
 * The 2-D grid does not have this problem because it does the opposite thing:
 * `buildGroundGrid` stamps obstacles then calls `fillFreeSpace`, which makes everything
 * not-obstructed free. **Free space is the bounding box; walls do all the separating.**
 * Doorways are gaps in the wall boxes, which is exactly how `house-01` authors them
 * (`wall-w-bath-a` stops at z = -3 and `wall-w-bath-b` resumes at z = -2, leaving the
 * bath doorway between them).
 *
 * So this now does the same, for the reason that matters: if the two manifolds disagreed
 * about where walls are, no comparison between them would mean anything. A bot that
 * could fly through a wall the ground bot cannot would make every coverage number
 * incomparable.
 *
 * ## A consequence worth stating: `rooms` is decoration in this house
 *
 * Nothing in the codebase reads `house.rooms` except validation. `house-01` is one open
 * volume with partial wall furniture, and the room list describes an intention the
 * geometry does not enforce. That is tolerable for the ground manifold, which only cares
 * about obstacles, but it means **an attic cannot be authored as a room** — under this
 * model a room adds nothing. It has to be authored as obstacles: a ceiling slab, and
 * exterior walls tall enough to enclose the space above it. That is what
 * `ceiling-a`..`ceiling-d` are.
 *
 * ## Obstacles are subtracted by 3-D overlap, ignoring their declared `manifold`
 *
 * The `manifold` field records where an obstacle was *authored* to matter, which for all
 * 26 existing obstacles means `ground`. But a 2.6 m plaster wall absolutely stops a hover
 * bot, and a 0.1 m threshold absolutely does not. Testing 3-D overlap gets both right
 * with one rule, where filtering on `manifold` would let the bot fly through every wall.
 */

import type { Aabb } from '../types.ts'
import type { House } from './geometry.ts'
import { clamp } from '../math.ts'

/** Spec §5.4: 0.10 m voxels. Chosen so a 0.9 m headroom and a 1.0 m one differ. */
export const VOXEL = 0.1

export const VOXEL_UNKNOWN = 0
export const VOXEL_FREE = 1
/** In a room AABB but subtracted by an overlapping obstacle. */
export const VOXEL_OCCUPIED = 2
/** In the bounds, in no room, and therefore not habitable air. */
export const VOXEL_OUTSIDE = 3

export type VoxelGrid = {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly nx: number
  readonly ny: number
  readonly nz: number
  readonly cells: Uint8Array
}

/** Voxel coordinate of a world coordinate, floored. Exact, no rounding policy needed. */
function toVoxel(origin: number, extent: number, v: number): number {
  return clamp(Math.floor((v - origin) / VOXEL), 0, Math.ceil(extent / VOXEL) - 1)
}

export function voxelIndex(g: VoxelGrid, ix: number, iy: number, iz: number): number {
  return ix + g.nx * (iy + g.ny * iz)
}

export function inVoxelBounds(g: VoxelGrid, ix: number, iy: number, iz: number): boolean {
  return ix >= 0 && ix < g.nx && iy >= 0 && iy < g.ny && iz >= 0 && iz < g.nz
}

/** World-space centre of a voxel. */
export function voxelCentreX(g: VoxelGrid, ix: number): number {
  return g.minX + (ix + 0.5) * VOXEL
}
export function voxelCentreY(g: VoxelGrid, iy: number): number {
  return g.minY + (iy + 0.5) * VOXEL
}
export function voxelCentreZ(g: VoxelGrid, iz: number): number {
  return g.minZ + (iz + 0.5) * VOXEL
}

export function voxelAt(g: VoxelGrid, ix: number, iy: number, iz: number): number {
  if (!inVoxelBounds(g, ix, iy, iz)) return VOXEL_OUTSIDE
  return g.cells[voxelIndex(g, ix, iy, iz)]!
}

/** Is this world point in habitable air? Used for spawn and arrival, not for planning. */
export function isFreeAt(g: VoxelGrid, x: number, y: number, z: number): boolean {
  const ix = toVoxel(g.minX, g.nx * VOXEL, x)
  const iy = toVoxel(g.minY, g.ny * VOXEL, y)
  const iz = toVoxel(g.minZ, g.nz * VOXEL, z)
  return voxelAt(g, ix, iy, iz) === VOXEL_FREE
}

/**
 * Build the volumetric grid.
 *
 * Two passes, in a fixed order, because the result has to be reproducible:
 *
 * 1. Everything inside `bounds` is free. Same starting point as the 2-D grid's
 *    `fillFreeSpace`.
 * 2. Subtract every voxel inside any blocking obstacle AABB.
 *
 * Obstacles are sorted by id so authoring order cannot change the result, and are
 * subtracted unconditionally on 3-D overlap. See the file header for why `manifold` is
 * not consulted and why rooms are not consulted either.
 */
export function buildVolumetricGrid(house: House): VoxelGrid {
  const b = house.bounds
  const nx = Math.ceil((b.maxX - b.minX) / VOXEL)
  const ny = Math.ceil((b.maxY - b.minY) / VOXEL)
  const nz = Math.ceil((b.maxZ - b.minZ) / VOXEL)

  const cells = new Uint8Array(nx * ny * nz).fill(VOXEL_FREE)

  // Anything physically in the way is not air, whatever manifold it was authored for. A
  // threshold 0.1 m tall does not overlap a voxel at 1.5 m and so subtracts nothing,
  // which is the correct answer without a special case.
  const obstacles = [...house.obstacles].sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0))
  for (const o of obstacles) {
    if (!o.blocking) continue
    stamp(cells, b, nx, ny, nz, o.aabb, VOXEL_OCCUPIED)
  }

  return { minX: b.minX, minY: b.minY, minZ: b.minZ, nx, ny, nz, cells }
}

function stamp(
  cells: Uint8Array,
  b: Aabb,
  nx: number,
  ny: number,
  nz: number,
  a: Aabb,
  value: number,
): void {
  // Half-open in the +direction so two abutting rooms do not both claim the boundary
  // voxel, which would otherwise make the shared face depend on iteration order.
  const x0 = clamp(Math.ceil((a.minX - b.minX) / VOXEL), 0, nx)
  const x1 = clamp(Math.ceil((a.maxX - b.minX) / VOXEL), 0, nx)
  const y0 = clamp(Math.ceil((a.minY - b.minY) / VOXEL), 0, ny)
  const y1 = clamp(Math.ceil((a.maxY - b.minY) / VOXEL), 0, ny)
  const z0 = clamp(Math.ceil((a.minZ - b.minZ) / VOXEL), 0, nz)
  const z1 = clamp(Math.ceil((a.maxZ - b.minZ) / VOXEL), 0, nz)

  for (let iz = z0; iz < z1; iz++) {
    for (let iy = y0; iy < y1; iy++) {
      const base = nx * (iy + ny * iz)
      for (let ix = x0; ix < x1; ix++) {
        cells[ix + base] = value
      }
    }
  }
}

/** One contiguous vertical stretch of free air. */
export type FreeRun = {
  readonly y0: number
  readonly y1: number
  readonly height: number
}

/**
 * Every contiguous free run in the column at (x, z), bottom to top.
 *
 * This is the function the clearance question actually needs, and it is *runs* rather
 * than a total because a total is a different and wrong number. At x = -4.2, z = 0.2
 * the column's free voxels total 3.40 m, but they are in two pieces — the hall at
 * 0.00-2.50 and the attic at 2.60-3.50 — separated by the 0.10 m slab. Nothing that has
 * to fit in this space can use both, so the honest reading of "headroom" is the tallest
 * run, not the sum.
 */
export function freeRunsAt(g: VoxelGrid, x: number, z: number): FreeRun[] {
  const ix = toVoxel(g.minX, g.nx * VOXEL, x)
  const iz = toVoxel(g.minZ, g.nz * VOXEL, z)
  if (!inVoxelBounds(g, ix, 0, iz)) return []

  const runs: FreeRun[] = []
  let start = -1
  for (let iy = 0; iy <= g.ny; iy++) {
    const free = iy < g.ny && g.cells[voxelIndex(g, ix, iy, iz)] === VOXEL_FREE
    if (free && start < 0) start = iy
    if (!free && start >= 0) {
      const y0 = g.minY + start * VOXEL
      const y1 = g.minY + iy * VOXEL
      runs.push({ y0, y1, height: y1 - y0 })
      start = -1
    }
  }
  return runs
}

/**
 * The tallest thing that fits in the column at (x, z).
 *
 * `height: 0` for a column with no free voxel at all, which is the honest answer for a
 * solid column rather than a missing one.
 */
export function headroomAt(
  g: VoxelGrid,
  x: number,
  z: number,
): { floorY: number; ceilingY: number; height: number } {
  const runs = freeRunsAt(g, x, z)
  if (runs.length === 0) return { floorY: g.minY, ceilingY: g.minY, height: 0 }
  let best = runs[0]!
  for (const r of runs) {
    if (r.height > best.height) best = r
  }
  return { floorY: best.y0, ceilingY: best.y1, height: best.height }
}

/**
 * The free run containing the point (x, y, z), or null if the point is not in air.
 *
 * This is the query the clearance penalty needs, and it is **not** `headroomAt`.
 * `headroomAt` answers "how much room is there", which for a column with a hall below an
 * attic returns 2.50 m — the tallest run — and would therefore tell a bot sitting in the
 * 0.90 m attic that it has 2.50 m of headroom. The clearance question is about the space
 * the bot is *in*, so this walks the contiguous run containing `y`.
 */
export function runAt(g: VoxelGrid, x: number, y: number, z: number): FreeRun | null {
  const ix = toVoxel(g.minX, g.nx * VOXEL, x)
  const iy = toVoxel(g.minY, g.ny * VOXEL, y)
  const iz = toVoxel(g.minZ, g.nz * VOXEL, z)
  if (!inVoxelBounds(g, ix, iy, iz)) return null
  if (voxelAt(g, ix, iy, iz) !== VOXEL_FREE) return null

  let y0 = iy
  while (y0 > 0 && voxelAt(g, ix, y0 - 1, iz) === VOXEL_FREE) y0--
  let y1 = iy
  while (y1 < g.ny - 1 && voxelAt(g, ix, y1 + 1, iz) === VOXEL_FREE) y1++

  const lo = g.minY + y0 * VOXEL
  const hi = g.minY + (y1 + 1) * VOXEL
  return { y0: lo, y1: hi, height: hi - lo }
}

/** Free voxel count. The non-vacuity check: a grid with no free voxels is a sealed world. */
export function freeVoxelCount(g: VoxelGrid): number {
  let n = 0
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] === VOXEL_FREE) n++
  }
  return n
}

/**
 * Passability for an agent of a given body radius.
 *
 * ## Why the volumetric grid needs this and the raw grid is not enough
 *
 * A voxel is free when free air contains its *centre*. A 0.24 m rotorcraft does not fit
 * in a 0.10 m cell � it needs clearance for its whole rotor span, or it flies into the
 * wall it thought it had cleared. So planning has to happen against a mask that has been
 * dilated by the body radius, exactly as the 2-D ground grid does through
 * `passabilityMask(radiusCells)`.
 *
 * Dilation is a cube of side `2r+1` rather than a true ball, because a cube is what the
 * 2-D version uses and a disagreement between the two manifolds on how "fits" is decided
 * would be a worse bug than the small over-conservatism. `radiusCells` is
 * `ceil(radius / VOXEL)`, so the hover bot's 0.12 m becomes 2 cells � 0.20 m of
 * clearance, which over-reserves by 0.08 m. That is deliberate: over-reserving costs a
 * little range in tight spots, under-reserving crashes the bot.
 *
 * ## Clearance is deliberately NOT in this mask
 *
 * The hover bot's 1.0 m ceiling clearance is an *operating cost*, not geometry � spec
 * �3.3 lists "maintain altitude in a 0.9 m attic without cost penalty" under *Cannot*,
 * and open question 1 asks whether low-clearance flight is expensive or impossible.
 * Folding it into occupancy would answer that question by fiat, before anything has been
 * measured. So geometry safety lives here and the clearance cost lives in the power model.
 */
export function volumetricPassability(g: VoxelGrid, radiusCells: number): Uint8Array {
  const n = g.nx * g.ny * g.nz
  const out = new Uint8Array(n)
  const r = Math.max(0, Math.floor(radiusCells))

  for (let iz = 0; iz < g.nz; iz++) {
    for (let iy = 0; iy < g.ny; iy++) {
      for (let ix = 0; ix < g.nx; ix++) {
        const i = ix + g.nx * (iy + g.ny * iz)
        if (g.cells[i] !== VOXEL_FREE) continue
        if (r === 0) {
          out[i] = 1
          continue
        }
        // Early-out on the first blocked cell in the cube: most free voxels near a wall
        // fail on the first probe, and this is the hot loop.
        //
        // Anything that is not VOXEL_FREE blocks, **including VOXEL_OUTSIDE**. That
        // distinction is load-bearing and the first version got it wrong: it rejected
        // only `VOXEL_OCCUPIED`, i.e. authored obstacles. But room boundaries are not
        // obstacles — they are expressed as "in no room", which is `VOXEL_OUTSIDE` — so
        // dilation could not see them.
        //
        // Measured effect of getting it wrong, at the hover bot's 2 cells (0.20 m):
        //
        //   obstacles-only   135,423 passable
        //   not-free         113,035 passable
        //   difference        -22,388 voxels, which is **13.08% of all free air**
        //
        // So 13% of the house's habitable volume was handing the bot 0.20 m of clearance
        // through surfaces that are not there. A room's edge is a wall whether or not an
        // obstacle says so.
        let clear = true
        for (let dz = -r; dz <= r && clear; dz++) {
          const jz = iz + dz
          // Off-grid is not air either, and the same argument applies: a body cannot hang
          // half outside the world. In practice this costs almost nothing, because the
          // house's own walls sit at `bounds`, so the voxels it would affect are already
          // OCCUPIED.
          if (jz < 0 || jz >= g.nz) {
            clear = false
            break
          }
          for (let dy = -r; dy <= r && clear; dy++) {
            const jy = iy + dy
            if (jy < 0 || jy >= g.ny) {
              clear = false
              break
            }
            const rowBase = g.nx * (jy + g.ny * jz)
            for (let dx = -r; dx <= r; dx++) {
              const jx = ix + dx
              if (jx < 0 || jx >= g.nx) {
                clear = false
                break
              }
              if (g.cells[jx + rowBase] !== VOXEL_FREE) {
                clear = false
                break
              }
            }
          }
        }
        if (clear) out[i] = 1
      }
    }
  }
  return out
}
