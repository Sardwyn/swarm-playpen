/**
 * 3-D ray casting against the voxel grid. Spec §5.4, Stage F.
 *
 * ## Why this exists, and what it is genuinely good for
 *
 * The hover bot's **thermal** sensor is a 2-D projection lookup and carries no height
 * information at all — §11.28 measured that leak: an attic defect 3 m up is readable from
 * the floor beneath it. So there is no point pretending the hover bot's advantage is
 * thermal.
 *
 * Its **depth** sensor is genuinely three-dimensional, because it casts against real
 * voxels. That is the part of the volumetric manifold that carries information the ground
 * manifold does not have:
 *
 * - the distance to a ceiling, so "how much room is above me" is an observation rather
 *   than an inference from the room's `maxY`;
 * - the height of a beam, the top of a fridge, the lip of a soffit — geometry that exists
 *   only above 1.0 m, where the ground bot cannot go at all;
 * - free space, directly, instead of inferred from 2-D occupancy.
 *
 * So this is the module that makes the manifold worth having, and the ceiling raster built
 * on it is a *geometric* raster with a thermal layer that is honestly labelled as 2-D.
 *
 * ## DDA, not a fixed step
 *
 * Amanatides-Woo voxel traversal: step to the next voxel boundary along whichever axis has
 * the smallest remaining distance. Two reasons:
 *
 * - **No tunnelling.** A fixed step of, say, 0.05 m can miss a 0.10 m voxel corner entirely.
 *   DDA visits every voxel the ray actually passes through, so a hit cannot be skipped.
 * - **Exact and deterministic.** The returned point is a voxel face, computed by comparison
 *   rather than accumulation, so the same ray always returns the same distance. A fixed-step
 *   march accumulates float error that depends on how the step was chosen.
 *
 * No transcendentals: the per-axis step is a division, and the normalisation is a `sqrt`.
 */

import { VOXEL, voxelIndex, inVoxelBounds, type VoxelGrid } from './volumetric.ts'
import { sqrt, abs } from '../math.ts'

export type RayHit = {
  readonly distance: number
  /** World point on the surface, i.e. the face the ray entered through. */
  readonly x: number
  readonly y: number
  readonly z: number
  /**
   * Which face was struck. Needed to tell a ceiling from a floor from a wall.
   *
   * `'origin'` means the ray *started* inside non-air, so there was no face to enter
   * through and the reported distance of 0 is not a measurement. That case is a bug in the
   * caller's spawn logic, and it gets its own label rather than a plausible-looking `face`
   * and a plausible-looking zero — which is how "the sensor is 0 m from everything" bugs
   * survive.
   */
  readonly face: 'x' | 'y' | 'z' | 'origin'
}

const NO_HIT: RayHit = { distance: Number.POSITIVE_INFINITY, x: 0, y: 0, z: 0, face: 'y' }

/**
 * March a ray until it leaves `maxDistance` or strikes a cell that is not free.
 *
 * Returns `NO_HIT` (distance `Infinity`) when nothing was struck, which callers must treat
 * as "no return" rather than as a hit at infinity — the same distinction the 2-D depth scan
 * makes, and the same trap: a return at infinity silently becomes a very long range, which
 * then reads as a confident far-field observation.
 */
export function castRay3(
  grid: VoxelGrid,
  mask: Uint8Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): RayHit {
  const len = sqrt(dx * dx + dy * dy + dz * dz)
  if (len < 1e-12) return NO_HIT
  // Normalise in place on local copies, so the caller's direction is untouched.
  const ux = dx / len
  const uy = dy / len
  const uz = dz / len

  let ix = Math.floor((ox - grid.minX) / VOXEL)
  let iy = Math.floor((oy - grid.minY) / VOXEL)
  let iz = Math.floor((oz - grid.minZ) / VOXEL)
  if (!inVoxelBounds(grid, ix, iy, iz)) return NO_HIT

  const stepX = ux > 0 ? 1 : -1
  const stepY = uy > 0 ? 1 : -1
  const stepZ = uz > 0 ? 1 : -1

  // Distance along the ray to the next boundary on each axis. The `+ 1e-9` keeps a
  // direction lying exactly in a plane from producing a zero-length first step, which would
  // otherwise spin the loop on the same boundary.
  const tDeltaX = abs(ux) < 1e-12 ? Number.POSITIVE_INFINITY : VOXEL / abs(ux)
  const tDeltaY = abs(uy) < 1e-12 ? Number.POSITIVE_INFINITY : VOXEL / abs(uy)
  const tDeltaZ = abs(uz) < 1e-12 ? Number.POSITIVE_INFINITY : VOXEL / abs(uz)

  const nextBoundary = (origin: number, min: number, i: number, step: number, u: number): number => {
    if (abs(u) < 1e-12) return Number.POSITIVE_INFINITY
    const boundary = step > 0 ? min + (i + 1) * VOXEL : min + i * VOXEL
    return (boundary - origin) / u
  }

  let tMaxX = nextBoundary(ox, grid.minX, ix, stepX, ux)
  let tMaxY = nextBoundary(oy, grid.minY, iy, stepY, uy)
  let tMaxZ = nextBoundary(oz, grid.minZ, iz, stepZ, uz)

  // If the origin is exactly on a boundary, the ray may immediately be leaving the cell it
  // is nominally in. Nudge forward by one voxel so the traversal starts inside.
  if (tMaxX < 0) {
    ix += stepX
    tMaxX += tDeltaX
  }
  if (tMaxY < 0) {
    iy += stepY
    tMaxY += tDeltaY
  }
  if (tMaxZ < 0) {
    iz += stepZ
    tMaxZ += tDeltaZ
  }

  let travelled = 0
  let face: 'x' | 'y' | 'z' | 'origin' = 'origin'

  // Bounded by voxel count rather than an arbitrary iteration cap: the longest possible
  // traversal is the grid diagonal in voxels, and anything beyond that is a bug.
  const maxSteps = grid.nx + grid.ny + grid.nz + 3

  for (let step = 0; step < maxSteps; step++) {
    if (!inVoxelBounds(grid, ix, iy, iz)) return NO_HIT
    const cell = mask[voxelIndex(grid, ix, iy, iz)]
    if (cell !== 1) {
      // The ray struck this voxel on entry. `travelled` is the distance to the face it
      // entered through, which is the surface the sensor would see. At travelled === 0 the
      // origin itself was in geometry, and `face` is still `'origin'` — the caller gets a
      // distinguishable "you started inside a wall" rather than a believable zero.
      return {
        distance: travelled,
        x: ox + ux * travelled,
        y: oy + uy * travelled,
        z: oz + uz * travelled,
        face,
      }
    }

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      travelled = tMaxX
      ix += stepX
      tMaxX += tDeltaX
      face = 'x'
    } else if (tMaxY < tMaxZ) {
      travelled = tMaxY
      iy += stepY
      tMaxY += tDeltaY
      face = 'y'
    } else {
      travelled = tMaxZ
      iz += stepZ
      tMaxZ += tDeltaZ
      face = 'z'
    }

    if (travelled > maxDistance) return NO_HIT

    // ## Leaving the grid is hitting the world, not escaping it
    //
    // The first version returned NO_HIT here, which is wrong for this world. Free space is
    // `bounds` minus obstacles, so the boundary of the grid *is* the inside of the outer
    // shell — and the shell is only partly authored as obstacles. Measured consequence of
    // the bug: an up-ray in the attic returned no hit, so the depth sensor reported
    // unlimited headroom in the one room whose headroom is the whole point, while the
    // clearance model said 0.60 m. **Two sources of truth for the same fact**, and the
    // sensor was the wrong one.
    //
    // The fix is to treat the domain edge as a surface. It is also consistent with the
    // horizontal case: the exterior walls sit *inside* `bounds`, so a horizontal ray
    // already hits an obstacle before reaching the edge, and only the vertical faces relied
    // on this.
    if (!inVoxelBounds(grid, ix, iy, iz)) {
      return {
        distance: travelled,
        x: ox + ux * travelled,
        y: oy + uy * travelled,
        z: oz + uz * travelled,
        face,
      }
    }
  }

  return NO_HIT
}

/** Did the ray hit anything within range? The infinity trap, named once. */
export function rayHit(hit: RayHit): boolean {
  return Number.isFinite(hit.distance)
}

/**
 * Ceiling distance straight up from a point: the first non-free voxel above.
 *
 * Separate from `castRay3` because "how far is the ceiling" is asked every tick by the
 * clearance model and does not need a general ray. Returns `maxRange` when nothing is
 * struck, which is a *bounded* answer — unlike `castRay3`'s infinity, because a caller
 * asking "is there room for me here" wants a number it can compare against its own size.
 */
export function ceilingDistance(
  grid: VoxelGrid,
  mask: Uint8Array,
  x: number,
  y: number,
  z: number,
  maxRange: number,
): number {
  const hit = castRay3(grid, mask, x, y, z, 0, 1, 0, maxRange)
  return rayHit(hit) ? hit.distance : maxRange
}