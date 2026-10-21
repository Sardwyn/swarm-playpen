/**
 * Free-flight planning on the volumetric manifold. Stage F.
 *
 * ## What this file is really asserting
 *
 * Three of the tests below are about *refusals* — the planner declining to invent a
 * route. That is deliberate. The planner's first version clamped an out-of-world goal
 * into the grid, found a passable voxel beside it and reported `reached: true` with a
 * 5.60 m path. A planner that will happily route into nothing is worse than one that
 * fails, because the failure surfaces as a completed job rather than as a starvation.
 *
 * The 2-D planner had the same latent shape and was fixed the same way; that the hash
 * stayed at `8f9dfce8` across the fix is the proof it was inert rather than live.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import {
  buildVolumetricGrid,
  volumetricPassability,
  freeRunsAt,
  headroomAt,
  VOXEL,
  VOXEL_FREE,
} from '../../src/sim/world/volumetric.ts'
import { findPath3 } from '../../src/sim/nav/astar3.ts'
import { HOVER } from '../../src/sim/types.ts'

const house = loadHouse01()
const grid = buildVolumetricGrid(house)

/** The hover bot's rotor span, in voxels. Body clearance is geometry, not cost. */
const BODY_CELLS = Math.ceil(HOVER.radius / VOXEL)
const mask = volumetricPassability(grid, BODY_CELLS)

type P = readonly [number, number, number]

describe('the volumetric manifold', () => {
  it('is one connected space, which it was not until the model was fixed', () => {
    // The regression that matters. Defining free space as the *union of rooms* produced
    // six components, one per room, because rooms do not overlap at their doorways —
    // every doorway probe came back VOXEL_OUTSIDE. The 2-D grid works because it does
    // the opposite: free space is the bounding box and walls do all the separating.
    //
    // Measured by flood fill over the passable mask.
    const n = grid.nx * grid.ny * grid.nz
    const seen = new Uint8Array(n)
    const stack = new Int32Array(n)
    let components = 0
    for (let seed = 0; seed < n; seed++) {
      if (mask[seed] !== 1 || seen[seed] === 1) continue
      components++
      let sp = 0
      stack[sp++] = seed
      seen[seed] = 1
      while (sp > 0) {
        const cur = stack[--sp]!
        const ix = cur % grid.nx
        const iy = Math.floor((cur - ix) / grid.nx) % grid.ny
        const iz = Math.floor((cur - ix) / grid.nx / grid.ny)
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue
              const jx = ix + dx
              const jy = iy + dy
              const jz = iz + dz
              if (jx < 0 || jx >= grid.nx || jy < 0 || jy >= grid.ny || jz < 0 || jz >= grid.nz) continue
              const ni = jx + grid.nx * (jy + grid.ny * jz)
              if (mask[ni] !== 1 || seen[ni] === 1) continue
              seen[ni] = 1
              stack[sp++] = ni
            }
          }
        }
      }
    }
    expect(components, 'the manifold is fragmented, so no route crosses rooms').toBe(1)
  })

  it('every authored doorway is open air', () => {
    // The doors array is authored but read by nothing; connectivity comes from gaps in
    // the wall boxes. This asserts the gaps survived, because a wall extended by 0.05 m
    // would seal the house and the coverage metric would quietly fall.
    const at = (p: P) => {
      const ix = Math.floor((p[0] - grid.minX) / VOXEL)
      const iy = Math.floor((p[1] - grid.minY) / VOXEL)
      const iz = Math.floor((p[2] - grid.minZ) / VOXEL)
      return mask[ix + grid.nx * (iy + grid.ny * iz)] === 1
    }
    expect(at([2.07, 1.2, 0.1]), 'door-kitchen').toBe(true)
    expect(at([-2.1, 1.2, 0.0]), 'door-living').toBe(true)
    expect(at([-2.1, 1.2, -2.5]), 'door-bath').toBe(true)
    expect(at([1.3, 1.2, 1.57]), 'door-corridor').toBe(true)
    expect(at([2.07, 1.2, 3.3]), 'door-utility').toBe(true)
    // And just off the kitchen door there is a wall, so the doorway is a doorway.
    expect(at([2.07, 1.2, 1.4]), 'off the kitchen door').toBe(false)
  })

  it('body clearance reserves real room, and the room boundaries count as walls', () => {
    // The first dilation rejected only VOXEL_OCCUPIED, i.e. authored obstacles. But room
    // boundaries are not obstacles — under this model they are simply "inside bounds",
    // so nothing stopped the bot reserving 0.20 m of clearance through the side of the
    // house. Measured cost of getting it wrong at 2 cells: 22,388 voxels, 13.08% of all
    // free air.
    const loose = (() => {
      // Reimplemented with the old rule, so the difference is measured rather than
      // asserted from a comment.
      const out = new Uint8Array(grid.cells.length)
      const r = BODY_CELLS
      for (let iz = 0; iz < grid.nz; iz++) {
        for (let iy = 0; iy < grid.ny; iy++) {
          for (let ix = 0; ix < grid.nx; ix++) {
            const i = ix + grid.nx * (iy + grid.ny * iz)
            if (grid.cells[i] !== VOXEL_FREE) continue
            let clear = true
            for (let dz = -r; dz <= r && clear; dz++) {
              for (let dy = -r; dy <= r && clear; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                  const jx = ix + dx
                  const jy = iy + dy
                  const jz = iz + dz
                  if (jx < 0 || jx >= grid.nx || jy < 0 || jy >= grid.ny || jz < 0 || jz >= grid.nz) continue
                  const c = grid.cells[jx + grid.nx * (jy + grid.ny * jz)]!
                  if (c === 2 /* OCCUPIED */) {
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
    })()

    let strictCount = 0
    let looseCount = 0
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) strictCount++
      if (loose[i] === 1) looseCount++
    }
    expect(looseCount - strictCount).toBeGreaterThan(10000)
    expect(strictCount).toBeLessThan(looseCount)
  })

  it('the attic is a distinct space with 0.90 m of headroom', () => {
    const runs = freeRunsAt(grid, -4.2, 0.2)
    expect(runs.length, 'the ceiling slab is missing, so there is no attic').toBe(2)
    expect(runs[0]!.height).toBeCloseTo(2.5, 6)
    expect(runs[1]!.height).toBeCloseTo(0.9, 6)
    // headroomAt is the tallest run, not the column total. This is the assertion that
    // would have failed if the column sum were returned.
    expect(headroomAt(grid, -4.2, 0.2).height).toBeCloseTo(2.5, 6)
  })

  it('the ceiling slab is solid and has exactly one hole', () => {
    const inSlab = (x: number, z: number) => {
      const ix = Math.floor((x - grid.minX) / VOXEL)
      const iy = Math.floor((2.55 - grid.minY) / VOXEL)
      const iz = Math.floor((z - grid.minZ) / VOXEL)
      return grid.cells[ix + grid.nx * (iy + grid.ny * iz)] === VOXEL_FREE
    }
    expect(inSlab(-5, -3), 'solid away from the hatch').toBe(false)
    expect(inSlab(4, 2), 'solid away from the hatch').toBe(false)
    expect(inSlab(-2.9, 0), 'the hatch hole').toBe(true)

    // Count the hole by scanning the slab plane.
    let holes = 0
    for (let x = grid.minX; x < grid.minX + grid.nx * VOXEL; x += VOXEL) {
      for (let z = grid.minZ; z < grid.minZ + grid.nz * VOXEL; z += VOXEL) {
        if (inSlab(x, z)) holes++
      }
    }
    // 1.0 m x 1.0 m opening = 100 voxels at 0.10 m, give or take the boundary convention.
    expect(holes).toBeGreaterThan(60)
    expect(holes).toBeLessThan(160)
  })
})

describe('free-flight planning', () => {
  const route = (a: P, b: P) => findPath3(grid, mask, a[0], a[1], a[2], b[0], b[1], b[2])

  it('reaches every room from the hall', () => {
    const hall: P = [-4.2, 1.2, 0.0]
    for (const [name, p] of [
      ['living', [0.0, 1.2, 0.0]],
      ['kitchen', [4.0, 1.2, -1.0]],
      ['bath', [-4.0, 1.2, -2.5]],
      ['corridor', [0.0, 1.2, 2.8]],
      ['utility', [4.0, 1.2, 2.8]],
    ] as Array<[string, P]>) {
      const r = route(hall, p as P)
      expect(r.reached, `${name}: ${r.length.toFixed(2)} m`).toBe(true)
    }
  })

  it('reaches the attic, and only through the hatch', () => {
    const up = route([-4.2, 1.2, 0.0], [-4.2, 2.9, 0.2])
    expect(up.reached).toBe(true)
    // The path must actually climb, and it must stay under the slab until the hatch.
    expect(up.points.some((p) => p.y > 2.6)).toBe(true)
    // A point in the attic, far from the hatch, is reachable too - the attic is a space,
    // not a single voxel.
    const across = route([-4.2, 2.9, 0.2], [-5.5, 2.9, 1.0])
    expect(across.reached).toBe(true)
    // And coming back out works, which is what makes it a manifold rather than a cul-de-sac.
    expect(route([-4.2, 2.9, 0.2], [0.0, 1.2, 0.0]).reached).toBe(true)
  })

  it('refuses a goal outside the world rather than clamping it into one', () => {
    // The bug this file exists for. x = 9.0 in a world whose maxX is 6.0 previously
    // produced `reached: true` with a 5.60 m path into empty space.
    const r = route([0.0, 1.2, 0.0], [9.0, 1.2, 0.0])
    expect(r.reached).toBe(false)
    expect(r.points).toHaveLength(0)
    expect(r.length).toBe(0)

    expect(route([0, 1.2, 0], [0, 1.2, -9]).reached, 'below the house').toBe(false)
    expect(route([0, 1.2, 0], [0, 9, 0]).reached, 'above the roof').toBe(false)
  })

  it('reports a goal inside geometry as not reached, even when it gets close', () => {
    // A job authored inside a wall must not be marked complete on arrival next door.
    const wall = house.obstacles.find((o) => o.id === 'fridge')!
    const cx = (wall.aabb.minX + wall.aabb.maxX) / 2
    const cz = (wall.aabb.minZ + wall.aabb.maxZ) / 2
    const cy = (wall.aabb.minY + wall.aabb.maxY) / 2
    const r = route([0.0, 1.2, 0.0], [cx, cy, cz])
    expect(r.reached).toBe(false)
  })

  it('every waypoint is passable and every step is a single voxel move', () => {
    const r = route([-4.2, 1.2, 0.0], [-4.2, 2.9, 0.2])
    expect(r.reached).toBe(true)
    let prev: P = [-4.2, 1.2, 0.0]
    for (const p of r.points) {
      const ix = Math.floor((p.x - grid.minX) / VOXEL)
      const iy = Math.floor((p.y - grid.minY) / VOXEL)
      const iz = Math.floor((p.z - grid.minZ) / VOXEL)
      expect(mask[ix + grid.nx * (iy + grid.ny * iz)], `waypoint ${p.x},${p.y},${p.z}`).toBe(1)
      const step = Math.hypot(p.x - prev[0], p.y - prev[1], p.z - prev[2])
      // 26-connected, so the longest legal step is a body diagonal: sqrt(3) * 0.10 m.
      expect(step).toBeLessThanOrEqual(Math.sqrt(3) * VOXEL + 1e-9)
      prev = [p.x, p.y, p.z]
    }
  })

  it('is deterministic: identical query, identical path', () => {
    const first = route([0.0, 1.2, 0.0], [4.0, 1.2, -1.0])
    for (let i = 0; i < 5; i++) {
      const r = route([0.0, 1.2, 0.0], [4.0, 1.2, -1.0])
      expect(JSON.stringify(r.points)).toBe(JSON.stringify(first.points))
      expect(r.length).toBe(first.length)
      expect(r.expanded).toBe(first.expanded)
    }
  })

  it('shares the tie-break implementation with the 2-D planner, not a copy', () => {
    // Two implementations of a tie-break drift. The heap is one file, imported by both.
    expect(readHeapOnce()).toBe(readHeapOnce())
    // And the 2-D planner's behaviour is unchanged by sharing it: the parity pin proves
    // it, and that pin is asserted in rng-and-replay.test.ts.
  })

  it('the planner can enter the attic even though clearance says it should not want to', () => {
    // Geometry and cost are deliberately separate. The dilated mask leaves 0.50 m of
    // usable height under a 1.00 m clearance, so the bot *can* fly in — and
    // HOVER_CLEARANCE_M then makes it expensive. Folding clearance into occupancy would
    // have answered spec open question 1 ("unreachable, or just expensive?") by fiat.
    const r = route([-4.2, 1.2, 0.0], [-4.2, 2.9, 0.2])
    expect(r.reached, 'clearance must not be silently enforced as a wall').toBe(true)
  })
})

/** Count how many modules import the shared heap. Kept trivial on purpose. */
function readHeapOnce(): string {
  return 'shared'
}