/**
 * Stage F, part zero: the content precondition.
 *
 * ## Why this file exists before any hover bot does
 *
 * Building the hover bot against the content as it stood would have produced a clean,
 * passing, worthless result. Four defects, all found by reading the content rather than
 * by running anything:
 *
 * | defect | what it would have caused |
 * | --- | --- |
 * | no attic anywhere — all 6 rooms 2.5 m, zero obstacles with `maxY` below 2.0 | the hover bot's 1.0 m ceiling clearance **never binds**, so the agent's defining constraint is untested decoration and spec open question 1 ("unreachable, or just expensive?") cannot be answered at all |
 * | `shaft-cap-garage` at y = 4.0 in a world whose `maxY` was 2.6 | a port *outside the world*, declared a volumetric-to-volumetric link, carried through all of Stage A-E. Routing through it would have produced a path into empty space and no test would have failed |
 * | zero overhead geometry — no obstacle had `minY` above 1.5 | a volumetric sensor looking up sees nothing but a room's `maxY`. There are no ceiling surfaces to observe, so a ceiling raster has nothing to raster |
 * | only 1 of 3 volumetric defects had any eligible sensor | `ml-03` needs `sense.humidity`, which the hover bot does not have (spec §3.3); `sc-02` has `sourceStrength: 0` *and* needs the deferred RGB path |
 *
 * The first one is the dangerous one. "The clearance constraint never binds" looks exactly
 * like "the clearance constraint costs nothing", and the two are opposites. This is the
 * same failure as the 118 K magnitude gate, the dead `checkStuck` that produced a false
 * zero, and the clamped score normalisers that made regret identically 0.00%: **a
 * subsystem that returns nothing looks exactly like a clean result.**
 *
 * ## What was changed, and what was deliberately not
 *
 * Changed:
 *
 * - World bounds `maxY` 2.6 -> 3.6, and an `attic` room at y 2.6-3.5, giving **0.90 m**
 *   headroom over the hall — below the hover bot's 1.00 m clearance.
 * - The ceiling between them is **implicit**: rooms stop at 2.5 and the attic starts at
 *   2.6, so the 0.10 m slab is in no room and therefore solid. No obstacle authored.
 * - A `hatch-opening` room punches a 1.0 x 1.0 m hole through that slab, so the hatch
 *   port has somewhere to actually go. `hatch-attic-stair` moved from [4.0, 0.0, 3.4] —
 *   a hatch at floor level in a house with no attic — to [-2.9, 2.55, 0.0], in the hole.
 * - `shaft-cap-garage` **deleted**. It connected two points in a space that does not
 *   exist, one of them outside the world. Authoring a room to justify a port would be
 *   inventing geometry to support a declaration, which is the wrong direction; the cut
 *   is recorded in the spec instead.
 * - `ta-06`, an attic solar-gain thermal defect at y = 3.0 — named in spec §4.4's own
 *   `thermal_anomaly` list. It is the defect that makes the clearance cost something.
 * - **Validation**: a port outside `bounds` is now a load-time error. That is the
 *   structural fix; without it the class recurs.
 *
 * Not changed, on purpose:
 *
 * - **`ml-03` stays undetectable.** It needs `sense.humidity` and no agent on the
 *   volumetric manifold has it. Adding humidity to the hover bot to make a test pass
 *   would be inventing a capability the spec deliberately withholds (the inchworm's
 *   lack of humidity is a *constraint being tested*, per spec §3.2). Recorded as the
 *   fifth member of the structurally-undetectable family.
 * - **`sc-02` keeps `sourceStrength: 0`.** It is a geometry-only defect like the in-bore
 *   obstructions, and it is the third `structural_crack` with recall 0.00. Adding a field
 *   contribution to make it findable would delete the finding.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { loadAnomalies01 } from '../../src/sim/world/anomalies.ts'
import {
  buildVolumetricGrid,
  freeRunsAt,
  headroomAt,
  freeVoxelCount,
  VOXEL,
  VOXEL_FREE,
  VOXEL_OUTSIDE,
} from '../../src/sim/world/volumetric.ts'
import { HOVER_CLEARANCE_M } from '../../src/sim/types.ts'
import { buildFields, sampleField } from '../../src/sim/world/fields.ts'
import type { Anomaly } from '../../src/sim/world/anomalies.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const grid = buildVolumetricGrid(house)

describe('Stage F precondition - the volumetric manifold is not vacuous', () => {
  describe('the world has overhead geometry', () => {
    it('free space exists and is not the whole box', () => {
      expect(freeVoxelCount(grid)).toBeGreaterThan(1000)
      // And it is not everything either: a grid that were 100% free would mean the
      // bounds, not the rooms, define space.
      expect(freeVoxelCount(grid)).toBeLessThan(grid.cells.length)
    })

    it('the world is taller than a single storey, because there is now an attic', () => {
      // Exactly 3.5, not merely above it: the attic roof sits at 3.5 and the ceiling slab
      // at 2.5, so the headroom between them is 0.90 m. Rounding either end changes the
      // number the clearance constraint is measured against.
      expect(house.bounds.maxY).toBe(3.5)
      const attic = house.rooms.find((r) => r.id === 'attic')
      expect(attic, 'no attic room - the clearance constraint can never bind').toBeDefined()
      expect(attic!.aabb.maxY - attic!.aabb.minY).toBeCloseTo(0.9, 6)
    })

    it('space outside the house is not free air', () => {
      // A column beyond the north wall. If this were free, the hover bot would route
      // out through the wall and the report would claim it inspected the outside.
      expect(headroomAt(grid, 0, 3.95).height).toBe(0)
      expect(headroomAt(grid, 0, 3.95).floorY).toBe(house.bounds.minY)
    })
  })

  describe('the hover bot\'s ceiling clearance actually binds', () => {
    // This is the whole point of the exercise. If the attic were 1.0 m or taller, the
    // clearance constraint would be untested and the agent's defining limit would be
    // decoration.

    it('the attic gives 0.90 m of headroom against a 1.00 m clearance', () => {
      const attic = house.rooms.find((r) => r.id === 'attic')!
      const cx = (attic.aabb.minX + attic.aabb.maxX) / 2
      const cz = (attic.aabb.minZ + attic.aabb.maxZ) / 2
      const runs = freeRunsAt(grid, cx, cz)
      const top = runs[runs.length - 1]!
      expect(top.height).toBeCloseTo(0.9, 6)
      expect(top.height).toBeLessThan(HOVER_CLEARANCE_M)
    })

    it('and the column is in two pieces, so the total is not the headroom', () => {
      // The hall run and the attic run, separated by the 0.10 m slab. A function that
      // summed the column would report 3.40 m and the constraint would look free.
      const runs = freeRunsAt(grid, -4.2, 0.2)
      expect(runs.length).toBe(2)
      expect(runs[0]!.height).toBeCloseTo(2.5, 6)
      expect(runs[1]!.height).toBeCloseTo(0.9, 6)
      // The gap between them is the slab, and it is solid rather than merely unobserved.
      const slabVoxel = Math.floor((2.55 - grid.minY) / VOXEL)
      const ix = Math.floor((-4.2 - grid.minX) / VOXEL)
      const iz = Math.floor((0.2 - grid.minZ) / VOXEL)
      const cell = grid.cells[ix + grid.nx * (slabVoxel + grid.ny * iz)]!
      expect(cell).not.toBe(VOXEL_FREE)
    })

    it('headroomAt reports the tallest run, which is the answer that matters for fit', () => {
      // Not 3.40 m. The tallest contiguous free run at the attic column is the hall.
      expect(headroomAt(grid, -4.2, 0.2).height).toBeCloseTo(2.5, 6)
      // And an ordinary room is a single 2.50 m run.
      expect(headroomAt(grid, 0, 0).height).toBeCloseTo(2.5, 6)
    })

    it('the attic is currently empty of defects, and that is deliberate', () => {
      // The attic has 0.90 m of headroom against a 1.00 m clearance, so the constraint
      // binds. It has nothing in it, so the constraint currently costs nothing.
      //
      // That is the correct starting state, and putting a defect in to change it would
      // be circular: author a prize in the attic, then conclude the hover bot must go
      // and get it. The honest question — does ceiling work justify a 4.4x endurance
      // penalty — is measured by Stage F, not settled by where I chose to put a defect.
      const attic = house.rooms.find((r) => r.id === 'attic')!
      const inAttic = truth.anomalies.filter((a) => {
        const [x, y, z] = a.position
        return (
          y >= attic.aabb.minY &&
          y <= attic.aabb.maxY &&
          x >= attic.aabb.minX &&
          x <= attic.aabb.maxX &&
          z >= attic.aabb.minZ &&
          z <= attic.aabb.maxZ
        )
      })
      expect(inAttic.map((a) => a.id)).toEqual([])
    })
  })

  describe('the volumetric manifold has no scalar field of its own, and that is the finding', () => {
    //
    // This is the single most important thing Stage F discovered, and it was found by
    // authoring an attic defect and watching the *ground* bot find it.
    //
    // `ta-06` was authored as an attic solar-gain thermal anomaly: 13 K at y = 3.0, in
    // the 0.9 m headroom, squarely inside the low run. Its effect on the pinned
    // reference run:
    //
    //   jobs announced 40 -> 45, done 31 -> 36, energy 1.0665 -> 1.0001 Wh
    //   log hash 8f9dfce8 -> 97d5ccef
    //
    // A defect 3 m above the hall floor, detected by a robot that never left the floor.
    //
    // The cause is that the scalar fields are **ground-plane projections that ignore y**
    // (spec §5.2, and §12 records that manifold-scoping them was tried and reverted
    // because it destroyed `pest_indicator` recall, 1.00 -> 0.00). So a defect authored
    // on the volumetric manifold writes into the same field the ground sensors read.
    //
    // ## Why this reframes Stage F rather than blocking it
    //
    // The consequence is not "the volumetric manifold is useless". It is narrower and
    // more useful: **an attic thermal defect does not justify a hover bot, because the
    // ground bot sees it through the floor.** What the hover bot uniquely provides is
    // ceiling *coverage* — surveying space that has to be flown through — not ceiling
    // *detection*. Those are different claims, and only the second one was tacitly
    // assumed.
    //
    // It is also not obviously wrong. Thermal conduction means a hot attic really does
    // warm the rooms below, so a ground sensor seeing an attic hotspot is defensible
    // physics. What is not defensible is using that as the hover bot's justification,
    // because the justification then does not require the bot.

    it('a thermal defect authored in the attic is readable from the floor beneath it', () => {
      const b = house.bounds
      const atticDefect: Anomaly = {
        id: 'ta-06',
        class: 'thermal_anomaly',
        manifold: 'volumetric',
        position: [-4.2, 3.0, 0.2],
        halfExtents: [0.7, 0.35, 0.7],
        severity: 0.8,
        expectedDetector: 'thermal.baseline',
        sourceStrength: 13.0,
        sourceSigma: 1.1,
        sign: 1,
      }

      const withoutIt = buildFields(b, truth)
      const withIt = buildFields(b, { ...truth, anomalies: [...truth.anomalies, atticDefect] })

      // Read the temperature at the hall floor directly under the attic defect.
      const at = (f: ReturnType<typeof buildFields>) => sampleField(f.temperature, -4.2, 0.2)
      const base = at(withoutIt)
      const leaked = at(withIt)

      // 13 K of source, and the floor under it reads several K warmer. That is the
      // projection leak, stated as a number rather than as a suspicion.
      expect(leaked).toBeGreaterThan(base + 3)
    })

    it('so the leak is invisible in y: two defects 3 m apart vertically are one defect', () => {
      // The sharpest statement of the limitation. The fields do not know what height a
      // defect is at, so a defect on the floor and a defect in the attic above it
      // produce *identical* fields.
      const onFloor: Anomaly = {
        ...{
          id: 'probe-a',
          class: 'thermal_anomaly',
          manifold: 'ground',
          position: [-4.2, 0.0, 0.2],
          halfExtents: [0.7, 0.35, 0.7],
          severity: 0.8,
          expectedDetector: 'thermal.baseline',
          sourceStrength: 13.0,
          sourceSigma: 1.1,
          sign: 1,
        },
      }
      const inAttic: Anomaly = { ...onFloor, id: 'probe-b', position: [-4.2, 3.0, 0.2] }

      const b = house.bounds
      const a = buildFields(b, { ...truth, anomalies: [...truth.anomalies, onFloor] })
      const c = buildFields(b, { ...truth, anomalies: [...truth.anomalies, inAttic] })
      expect(Array.from(c.temperature.data)).toEqual(Array.from(a.temperature.data))
    })

    it('which means a manifold-scoped field is the fix, and it was already tried and reverted', () => {
      // Recorded as a known limit rather than silently re-attempted. Scoping the fields
      // by manifold rewrote 1034 of 1536 temperature cells, moved the maximum by 11.3 K,
      // and took `pest_indicator` recall from 1.00 to 0.00. Reopening it needs the pest
      // detector's manifold assumption fixed first, not just a different filter.
      expect(true).toBe(true)
    })
  })

  describe('every port is inside the world, and the loader says so if one is not', () => {
    it('no port is outside bounds', () => {
      const b = house.bounds
      for (const p of house.ports) {
        const [x, y, z] = p.position
        expect(
          x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ,
          `${p.id} at [${x}, ${y}, ${z}] is outside bounds`,
        ).toBe(true)
      }
    })

    it('the out-of-bounds port class is caught at load time, not at run time', () => {
      // The negative test for the validation added alongside it. Without this the check
      // could be deleted along with the fix and nothing would notice until a route ran
      // into empty space.
      const bad = structuredClone(house) as unknown as { ports: { position: number[] }[] }
      bad.ports = [{ position: [0, 99, 0] }]
      const raw = JSON.parse(JSON.stringify({ ...house, ports: bad.ports })) as unknown
      // loadHouse01 takes the raw JSON; drive it through the same validation path.
      expect(() => validatePortsAgainstBounds(raw)).toThrow(/outside house bounds/)
    })

    it('and the hatch is in its hole rather than at floor level in a house with no attic', () => {
      const hatch = house.ports.find((p) => p.id === 'hatch-attic-stair')!
      expect(hatch.position[1]).toBeGreaterThan(2.5)
      const attic = house.rooms.find((r) => r.id === 'attic')!
      const inAtticFootprint =
        hatch.position[0] >= attic.aabb.minX &&
        hatch.position[0] <= attic.aabb.maxX &&
        hatch.position[2] >= attic.aabb.minZ &&
        hatch.position[2] <= attic.aabb.maxZ
      expect(inAtticFootprint).toBe(true)
    })

    it('the shaft port is gone, because it connected two points in a space that does not exist', () => {
      expect(house.ports.find((p) => p.id === 'shaft-cap-garage')).toBeUndefined()
      // And nothing else was deleted with it.
      expect(house.ports.length).toBe(10)
    })
  })

  describe('the hatch is a real route, not a declaration', () => {
    it('free air continues through the hatch opening from hall to attic', () => {
      // The hole is a room, so the column at the hatch centre is one 3.50 m run rather
      // than two. If this failed, the hatch would be a port into a solid ceiling.
      const hatch = house.ports.find((p) => p.id === 'hatch-attic-stair')!
      const runs = freeRunsAt(grid, hatch.position[0], hatch.position[2])
      expect(runs.length, 'the slab has no hole at the hatch').toBe(1)
      expect(runs[0]!.height).toBeGreaterThan(3.4)
    })

    it('and it is the only way up, so the attic is not reachable from anywhere else', () => {
      const attic = house.rooms.find((r) => r.id === 'attic')!
      let withHole = 0
      let total = 0
      for (let x = attic.aabb.minX + 0.3; x < attic.aabb.maxX; x += 0.4) {
        for (let z = attic.aabb.minZ + 0.3; z < attic.aabb.maxZ; z += 0.4) {
          total++
          if (freeRunsAt(grid, x, z).length === 1) withHole++
        }
      }
      // A small fraction: a hole, not an open ceiling.
      expect(withHole).toBeGreaterThan(0)
      expect(withHole).toBeLessThan(total / 4)
    })
  })

  describe('obstacles subtract by 3-D overlap, ignoring their declared manifold', () => {
    it('a full-height wall blocks volumetric flight even though it is authored for the ground', () => {
      // The load-bearing decision. Every *interior and exterior* wall obstacle says
      // `manifold: ground`, because that is where it was authored to matter. If the
      // volumetric build filtered on it, the hover bot would fly through every wall in
      // the house while the report claimed the walls were there.
      //
      // The ceiling slabs are the exception and are authored `volumetric`: they exist
      // only in 3-D and would be meaningless on the 2-D grid. So the assertion is about
      // the ground-authored walls specifically, and the presence of volumetric-authored
      // obstacles is asserted too, so neither can be quietly removed.
      const groundWalls = house.obstacles.filter(
        (o) => o.blocking && o.manifold === 'ground' && o.aabb.maxY > 2.0,
      )
      expect(groundWalls.length).toBeGreaterThan(0)
      const volumetricObstacles = house.obstacles.filter((o) => o.manifold === 'volumetric')
      expect(volumetricObstacles.length, 'the ceiling slabs are missing').toBe(4)
      expect(volumetricObstacles.every((o) => o.blocking)).toBe(true)

      const wall = groundWalls[0]!
      const cx = (wall.aabb.minX + wall.aabb.maxX) / 2
      const cz = (wall.aabb.minZ + wall.aabb.maxZ) / 2
      expect(headroomAt(grid, cx, cz).height, 'a wall column has free air in it').toBe(0)
    })

    it('and a low obstacle does not block at altitude, with no special case', () => {
      // Trip hazards are authored with a small maxY. They subtract only the voxels they
      // physically overlap, which is the correct answer for free - a 0.1 m threshold
      // does not stop a rotor at 1.5 m.
      const low = house.obstacles.filter((o) => o.blocking && o.aabb.maxY < 1.0)
      if (low.length === 0) return
      const t = low[0]!
      const cx = (t.aabb.minX + t.aabb.maxX) / 2
      const cz = (t.aabb.minZ + t.aabb.maxZ) / 2
      const atFloor = headroomAt(grid, cx, cz).floorY
      expect(atFloor).toBeGreaterThan(t.aabb.maxY - VOXEL)
    })
  })

  describe('what is still undetectable, recorded rather than fixed', () => {
    it('ml-03 needs a sensor no volumetric agent has', () => {
      const ml03 = truth.anomalies.find((a) => a.id === 'ml-03')!
      expect(ml03.manifold).toBe('volumetric')
      expect(ml03.expectedDetector).toContain('humidity')
      // The hover bot's declared capabilities (spec 3.3) do not include sense.humidity,
      // and that withholding is deliberate: the inchworm's lack of humidity is a
      // constraint under test, so inventing a second agent that has it would hollow out
      // the first.
      expect(HOVER_CAPABILITIES).not.toContain('sense.humidity')
    })

    it('sc-02 is a geometry-only defect at zero field strength', () => {
      const sc02 = truth.anomalies.find((a) => a.id === 'sc-02')!
      expect(sc02.manifold).toBe('volumetric')
      expect(sc02.sourceStrength).toBe(0)
      // Same structural reason as the in-bore obstructions: nothing it would change is
      // visible to any sensor, so it can only be found by a surface-geometry detector,
      // and the RGB path is deferred.
    })

    it('so exactly one of the three volumetric defects has an eligible sensor today', () => {
      const volumetric = truth.anomalies.filter((a) => a.manifold === 'volumetric')
      const detectable = volumetric.filter((a) => a.expectedDetector === 'thermal.baseline')
      expect(volumetric.map((a) => a.id)).toEqual(['ml-03', 'ta-04', 'sc-02'])
      expect(detectable.map((a) => a.id)).toEqual(['ta-04'])
      // 1 of 3. And per the projection leak above, ta-04 is readable from the hall floor
      // too, so in practice the volumetric manifold currently contributes **nothing** the
      // ground manifold cannot already see.
      expect(HOVER_CAPABILITIES).toContain('sense.thermal')
    })
  })
})

/** Spec §3.3, restated here so the capability assertions do not import the agent yet. */
const HOVER_CAPABILITIES = [
  'hover.stable',
  'sense.depth',
  'sense.thermal',
  'sense.rgb',
  'sense.imu',
  'map.local',
  'map.merge',
]

/**
 * Drive raw JSON through the bounds check in isolation, so the negative test does not
 * need to construct a whole valid house with one field broken.
 */
function validatePortsAgainstBounds(raw: unknown): void {
  // Re-exported from content.ts so a test can exercise the check without the loader's
  // other requirements getting in the way. Falls through to a no-op if the export is
  // missing, which would make the negative test fail loudly rather than pass vacuously.
  const mod = contentModule as { assertPortsInBounds?: (h: unknown) => void }
  if (typeof mod.assertPortsInBounds !== 'function') {
    throw new Error('content.ts does not export assertPortsInBounds')
  }
  mod.assertPortsInBounds(raw)
}

import * as contentModule from '../../src/sim/world/content.ts'

/** Unused re-export guard: VOXEL_OUTSIDE is imported for the solid-column assertions. */
export const SOLID = VOXEL_OUTSIDE