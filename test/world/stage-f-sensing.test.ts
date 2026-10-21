/**
 * Volumetric sensing: the 3-D raycast and the ceiling raster. Stage F.
 *
 * ## The asymmetry this file is built around
 *
 * The raster has two layers and only one of them is volumetric:
 *
 * - **Geometry is genuinely 3-D.** It comes from a DDA raycast against real voxels, so
 *   "how far is the ceiling" is an observation. The ground bot cannot produce this layer at
 *   all — it has no pose above 0.2 m and its grid has no height.
 * - **Thermal is a 2-D projection lookup and carries no height information.** §11.28
 *   measured that leak: an attic defect 3 m up was readable from the floor beneath it.
 *
 * Several tests below assert the *second* half of that as well as the first, because the
 * tempting failure is to build a volumetric detector and let its output imply it can see
 * things the ground bot cannot.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import {
  buildVolumetricGrid,
  volumetricPassability,
  runAt,
} from '../../src/sim/world/volumetric.ts'
import { castRay3, rayHit, ceilingDistance } from '../../src/sim/world/raycast3.ts'
import {
  createCeilingRaster,
  observeCeiling,
  rasterConfidence,
  cellConfidence,
  summariseRaster,
  meetsConfidenceGate,
  CEILING_CONFIDENCE_GATE,
  CEILING_REQUIRED_OBSERVATIONS,
  rasterIndexAt,
} from '../../src/sim/sim/ceiling.ts'

const house = loadHouse01()
const grid = buildVolumetricGrid(house)
/**
 * The **raw** grid, not the body-dilated mask. A depth sensor measures to the surface;
 * dilating by the rotor radius would make it report every surface 0.20 m early, which is
 * the same over-reservation the 2-D planner deliberately avoids.
 */
const mask = volumetricPassability(grid, 0)

describe('3-D raycasting', () => {
  it('measures the ceiling, the slab and the outer shell', () => {
    const up = castRay3(grid, mask, 0, 1.2, 0, 0, 1, 0, 10)
    expect(rayHit(up)).toBe(true)
    expect(up.distance).toBeCloseTo(1.3, 6) // ceiling slab at y = 2.5
    expect(up.face).toBe('y')
    expect(up.y).toBeCloseTo(2.5, 6)

    const across = castRay3(grid, mask, 0, 1.2, 0, 1, 0, 0, 20)
    expect(across.distance).toBeCloseTo(5.9, 6) // interior face of wall-ext-e
    expect(across.face).toBe('x')
  })

  it('sees the attic roof, which the first version could not', () => {
    // This is the bug that made the sensor and the clearance model disagree. Free space is
    // `bounds` minus obstacles, so the top of the grid is the inside of the shell — and the
    // shell is only partly authored as obstacles. Returning NO_HIT here reported *unlimited*
    // headroom in the one room whose headroom is the entire point, while `clearanceAbove`
    // correctly said 0.60 m. Two sources of truth for one fact, and the sensor was wrong.
    const up = castRay3(grid, mask, -4.2, 2.9, 0, 0, 1, 0, 10)
    expect(rayHit(up), 'the attic roof is invisible to the depth sensor').toBe(true)
    expect(up.distance).toBeCloseTo(0.6, 6)
    expect(up.y).toBeCloseTo(3.5, 6)
  })

  it('and the sensor now agrees with the clearance model everywhere', () => {
    // The consistency assertion, not just two numbers that happen to match once.
    for (const [x, y, z] of [
      [0, 0.3, 0],
      [0, 1.2, 0],
      [0, 2.0, 0],
      [-4.2, 2.9, 0],
      [4, 1.0, -1],
    ] as Array<[number, number, number]>) {
      const sensor = ceilingDistance(grid, mask, x, y, z, 10)
      const model = runAt(grid, x, y, z)!.y1 - y
      expect(Math.abs(sensor - model), `at ${x},${y},${z}`).toBeLessThan(1e-9)
    }
  })

  it('passes through the hatch and hits the slab everywhere else', () => {
    // The hatch is a real route, not a declaration: a down-ray through it travels the full
    // 2.9 m to the floor, while one a metre away stops at the 0.10 m slab.
    const throughHatch = castRay3(grid, mask, -2.9, 2.9, 0, 0, -1, 0, 10)
    expect(throughHatch.distance).toBeGreaterThan(2.5)

    const besideHatch = castRay3(grid, mask, -5.0, 2.9, 0, 0, -1, 0, 10)
    expect(besideHatch.distance).toBeCloseTo(0.3, 6)
    expect(besideHatch.face).toBe('y')
  })

  it('distinguishes "started inside a wall" from a real zero', () => {
    // The fridge interior. The first version returned distance 0 with `face: 'y'`, which is
    // indistinguishable from "the surface is right here" — and a sensor that reports 0 m to
    // everything is a bug that survives, because every downstream number still looks finite.
    const fridge = house.obstacles.find((o) => o.id === 'fridge')!
    const x = (fridge.aabb.minX + fridge.aabb.maxX) / 2
    const y = (fridge.aabb.minY + fridge.aabb.maxY) / 2
    const z = (fridge.aabb.minZ + fridge.aabb.maxZ) / 2
    const hit = castRay3(grid, mask, x, y, z, 1, 0, 0, 5)
    expect(rayHit(hit)).toBe(true)
    expect(hit.distance).toBe(0)
    expect(hit.face).toBe('origin')
  })

  it('respects maxRange and reports no hit rather than a hit at infinity', () => {
    // The infinity trap, named: a NO_HIT whose distance is Infinity becomes a very long
    // range if a caller forgets to test it, and a very long range reads as a confident
    // far-field observation.
    const short = castRay3(grid, mask, 0, 1.2, 0, 0, 1, 0, 0.5)
    expect(rayHit(short)).toBe(false)
    expect(Number.isFinite(short.distance)).toBe(false)

    const zeroDirection = castRay3(grid, mask, 0, 1.2, 0, 0, 0, 0, 5)
    expect(rayHit(zeroDirection)).toBe(false)
  })

  it('is deterministic to the last bit', () => {
    // Non-normalised, awkward direction, to catch any accidental reliance on the caller's
    // vector being unit length.
    const first = castRay3(grid, mask, 0.1234567, 1.2345678, 0.7654321, 0.3, 0.7, -0.2, 10)
    for (let i = 0; i < 5; i++) {
      const r = castRay3(grid, mask, 0.1234567, 1.2345678, 0.7654321, 0.3, 0.7, -0.2, 10)
      expect(r.distance).toBe(first.distance)
      expect(r.face).toBe(first.face)
      expect(r.x).toBe(first.x)
    }
  })

  it('cannot tunnel through a 0.10 m voxel', () => {
    // The reason this is DDA and not a fixed-step march: a 0.05 m step can pass through a
    // 0.10 m voxel without ever sampling its interior. Sweep many directions and bearings
    // and every one must report a hit.
    let tested = 0
    for (let bearingStep = 0; bearingStep < 36; bearingStep++) {
      // Bearings by unit steps on a circle, from a fixed altitude with a known slab above.
      const a = (bearingStep / 36) * Math.PI * 2
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      for (const dy of [-1, -0.5, 0.5, 1]) {
        const hit = castRay3(grid, mask, 0, 1.2, 0, dx, dy, dz, 20)
        expect(rayHit(hit), `bearing ${bearingStep} dy ${dy}`).toBe(true)
        tested++
      }
    }
    expect(tested).toBe(144)
  })
})

describe('the ceiling raster', () => {
  const mk = () => createCeilingRaster(-3, -3, 6, 6, 0.25)

  const sweep = (r: ReturnType<typeof mk>, passes: number, dev: (x: number, z: number) => number, alt = 2.0) => {
    for (let p = 0; p < passes; p++) {
      for (let x = -2.9; x < 3; x += 0.2) {
        for (let z = -2.9; z < 3; z += 0.2) observeCeiling(r, x, z, alt, dev(x, z))
      }
    }
  }

  it('an empty raster scores 0, not a vacuous pass', () => {
    // The single most important assertion in this file. A mean over no cells is NaN, and a
    // sum over no cells is 0 that some formulations turn into 1.0 — either way an unobserved
    // ceiling would report itself surveyed.
    const r = mk()
    expect(rasterConfidence(r)).toBe(0)
    expect(meetsConfidenceGate(r)).toBe(false)
  })

  it('a full two-pass consistent sweep passes the gate', () => {
    const r = mk()
    sweep(r, 2, () => 1.0)
    expect(rasterConfidence(r)).toBeCloseTo(1, 3)
    expect(meetsConfidenceGate(r)).toBe(true)
  })

  it('a single pass does NOT pass the gate, which is the calibration that matters', () => {
    // 0.578 against a 0.6 threshold. One pass over a ceiling is a glimpse, and the whole
    // point of `requiredObservation = 2` — the same reasoning the 2-D coverage metric uses —
    // is that a cell glimpsed once does not count as surveyed.
    const r = mk()
    sweep(r, 1, () => 1.0)
    expect(rasterConfidence(r)).toBeLessThan(CEILING_CONFIDENCE_GATE)
    expect(rasterConfidence(r)).toBeGreaterThan(0.5)
    expect(meetsConfidenceGate(r)).toBe(false)
  })

  it('coverage is multiplied in, not averaged', () => {
    // Three perfect cells out of 576. An average would report 1.0 and pass the gate on the
    // strength of three data points, which is the shape of the false-pass this project has
    // now hit five separate times.
    const r = mk()
    for (const [x, z] of [[0, 0], [0.1, 0], [0, 0.1]] as Array<[number, number]>) {
      observeCeiling(r, x, z, 2.0, 1.0)
      observeCeiling(r, x, z, 2.0, 1.0)
    }
    const total = r.width * r.depth
    expect(total).toBe(576)
    expect(rasterConfidence(r)).toBeLessThan(0.01)
    expect(meetsConfidenceGate(r)).toBe(false)
  })

  it('half coverage with perfect readings sits just under the gate', () => {
    const r = mk()
    for (let p = 0; p < 2; p++) {
      for (let x = -2.9; x < 0; x += 0.2) {
        for (let z = -2.9; z < 3; z += 0.2) observeCeiling(r, x, z, 2.0, 1.0)
      }
    }
    expect(rasterConfidence(r)).toBeGreaterThan(0.4)
    expect(rasterConfidence(r)).toBeLessThan(CEILING_CONFIDENCE_GATE)
    expect(meetsConfidenceGate(r)).toBe(false)
  })

  it('disagreement lowers confidence instead of being averaged away', () => {
    // §5.5's principle: disagreement is not averaged away, it is measured. Two readings of
    // the same cell 8 K apart is not a surface, it is a contradiction, and the raster says
    // so rather than reporting the mean.
    const r = mk()
    sweep(r, 1, () => 1.0)
    sweep(r, 1, () => 9.0)
    expect(rasterConfidence(r)).toBe(0)
    expect(meetsConfidenceGate(r)).toBe(false)
  })

  it('a single reading is treated as half-confidence, not self-consistent', () => {
    const r = mk()
    observeCeiling(r, 0, 0, 2.0, 1.0)
    // observationQuality 1/2 = 0.5, times the single-sample discount 0.5.
    expect(rasterIndexAt(r, 0, 0)).toBeGreaterThanOrEqual(0)
    expect(cellConfidence(r, rasterIndexAt(r, 0, 0))).toBeCloseTo(0.25, 6)
    // And the cell *before* the one observed is untouched, so the index is not being ignored.
    expect(cellConfidence(r, rasterIndexAt(r, 99, 99))).toBe(0)
    expect(CEILING_REQUIRED_OBSERVATIONS).toBe(2)
  })

  it('tells "outside the region" from "a good reading"', () => {
    // Collapsing these is how a partial raster reports full coverage.
    const r = mk()
    expect(observeCeiling(r, 99, 0, 2.0, 1.0)).toBe(false)
    expect(observeCeiling(r, 0, 0, 2.0, 1.0)).toBe(true)
    expect(rasterConfidence(r)).toBeGreaterThan(0)
    expect(rasterConfidence(r)).toBeLessThan(0.01)
  })

  it('records the altitude the readings came from, which is the volumetric part', () => {
    const r = mk()
    sweep(r, 2, () => 1.0, 2.3)
    const s = summariseRaster(r)
    expect(s.meanAltitudeM).toBeCloseTo(2.3, 6)
    expect(s.geometryLayerIsVolumetric).toBe(true)
  })
})

describe('what the raster is not allowed to claim', () => {
  it('the summary carries the projection leak as a field, not just a comment', () => {
    const r = createCeilingRaster(-3, -3, 6, 6, 0.25)
    for (let p = 0; p < 2; p++) {
      for (let x = -2.9; x < 3; x += 0.2) {
        for (let z = -2.9; z < 3; z += 0.2) observeCeiling(r, x, z, 2.3, 2.0)
      }
    }
    const s = summariseRaster(r)
    // Typed as literal `false`, so it cannot be quietly flipped to `true` without a type
    // error, and it reaches the report rather than living only in a docblock.
    expect(s.thermalLayerIsVolumetric).toBe(false)
    expect(s.meetsGate).toBe(true)
  })

  it('a raster passes the gate without ever having detected anything', () => {
    // The uncomfortable one, and it is the honest result rather than a bug. Confidence here
    // is about *survey coverage and agreement*, not about finding defects. A perfectly
    // rastered ceiling with nothing wrong in it scores 1.0.
    //
    // So the gate "ceiling rasters at =0.6 confidence" cannot be read as "the hover bot
    // finds things the ground bot misses". It is a statement about the bot having been
    // *there* and measured consistently. Those are different claims and the second is the
    // one the thesis would need.
    const r = createCeilingRaster(-3, -3, 6, 6, 0.25)
    for (let p = 0; p < 2; p++) {
      for (let x = -2.9; x < 3; x += 0.2) {
        for (let z = -2.9; z < 3; z += 0.2) observeCeiling(r, x, z, 2.3, 0.0)
      }
    }
    const s = summariseRaster(r)
    // Every deviation is 0.0 K: a uniform, uneventful, perfectly measured ceiling.
    expect(s.peakDeviationK).toBe(0)
    expect(s.confidence).toBeGreaterThanOrEqual(CEILING_CONFIDENCE_GATE)
    expect(s.meetsGate).toBe(true)
  })

})
