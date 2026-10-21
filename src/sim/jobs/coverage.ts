/**
 * The frontier-value coverage policy. Spec §11.12.
 *
 * ## Why this replaced "first unobserved cell in scan order"
 *
 * Stage C's policy announced a job for the first unobserved cell in row-major
 * order. That produced **126 coverage jobs in a 300-second run**, and it cost the
 * swarm a class: `pest_indicator` recall fell from 1.00 to 0.00 purely because the
 * resulting churn moved the robot somewhere else.
 *
 * The Stage C finding was that detection recall is a function of trajectory. The
 * honest fix is therefore the *policy*, not a detector threshold — the temptation
 * is always to move whichever number is failing.
 *
 * ## What the policy does
 *
 * 1. **Frontiers, not arbitrary cells**: unobserved, navigable, and touching
 *    already-observed space. A pocket of unobserved floor with no observed
 *    neighbour is not reachable from where the robot stands, so it is not a target.
 * 2. **Regions, not cells.** A frontier is a *connected run* of unexplored space
 *    and that is the natural unit of coverage work. One job per region rather than
 *    one per cell is the difference between a policy and a treadmill.
 * 3. **Nearest first, by path distance over the robot's own map** — not Euclidean,
 *    because work the robot must walk around a wall to reach is not as cheap as its
 *    straight-line distance suggests. This is the same honesty the auction depends
 *    on (spec §6.3).
 * 4. **Bounded**: at most a few regions in flight, so the coordinator announces work
 *    as it becomes relevant instead of flooding the market.
 */

import type { Aabb } from '../types.ts'
import type { Grid } from '../world/geometry.ts'
import { cellCenterX, cellCenterZ } from '../world/geometry.ts'
import { findPath } from '../nav/astar.ts'
import type { JobRecord } from './schema.ts'
import { mapRegionJob } from './schema.ts'

export type FrontierRegion = {
  readonly id: string
  readonly region: Aabb
  readonly centroid: { x: number; z: number }
  /** Frontier cells in this region. */
  readonly cells: number
  /** Path distance from the querying agent to the centroid, metres. */
  readonly distance: number
  /**
   * Mean number of observed 4-neighbours per frontier cell, 0..4.
   *
   * Higher means the region is better *supported*: the robot can get a bearing on
   * it from nearby known space, which is what makes sensing it worth doing rather
   * than speculative.
   */
  readonly support: number
  /** Lowest cell index in the region. Fixed tie-break so ordering is stable. */
  readonly minIndex: number
}

export type CoveragePolicy = {
  /** Cluster radius for grouping frontier cells into one job, metres. */
  readonly clusterRadius: number
  /** Maximum regions announced per tick. */
  readonly maxRegions: number
  /** Minimum frontier cells before a pocket counts as real work. */
  readonly minCells: number
  /** Sightings required before a cell counts as covered. Matches the metric. */
  readonly requiredObservation: number
}

export const DEFAULT_COVERAGE_POLICY: CoveragePolicy = {
  clusterRadius: 1.2,
  maxRegions: 2,
  minCells: 3,
  requiredObservation: 2,
}

type Bucket = { cells: number[]; supportSum: number }

/**
 * Frontier cells: navigable, unobserved, and adjacent to something observed.
 *
 * Deterministic by construction — cells are iterated in index order and clustering
 * walks a sorted key list, so the result depends on the map and not on traversal
 * order (spec §1.4).
 */
export function frontierCells(
  grid: Grid,
  mask: Uint8Array,
  requiredObservation = DEFAULT_COVERAGE_POLICY.requiredObservation,
): number[] {
  const out: number[] = []
  const w = grid.width
  for (let cz = 1; cz < grid.height - 1; cz++) {
    for (let cx = 1; cx < w - 1; cx++) {
      const i = cz * w + cx
      if (mask[i] !== 1) continue
      if (grid.observedCount[i]! >= requiredObservation) continue

      const touchesKnown =
        grid.observedCount[i - 1]! >= requiredObservation ||
        grid.observedCount[i + 1]! >= requiredObservation ||
        grid.observedCount[i - w]! >= requiredObservation ||
        grid.observedCount[i + w]! >= requiredObservation
      if (!touchesKnown) continue

      out.push(i)
    }
  }
  return out
}

/** Group frontier cells into regions, rank them, and measure path distance. */
export function frontierRegions(
  grid: Grid,
  mask: Uint8Array,
  agentX: number,
  agentZ: number,
  policy: CoveragePolicy = DEFAULT_COVERAGE_POLICY,
): FrontierRegion[] {
  const need = policy.requiredObservation
  const cells = frontierCells(grid, mask, need)
  if (cells.length === 0) return []

  const w = grid.width

  // Keyed by rounded world position so clustering is a hash lookup rather than an
  // O(n^2) scan over every pair of frontier cells.
  const remaining = new Map<string, number>()
  for (const i of cells) {
    const cx = i % w
    const cz = (i - cx) / w
    remaining.set(
      `${Math.round(cellCenterX(grid, cx) * 20)}:${Math.round(cellCenterZ(grid, cz) * 20)}`,
      i,
    )
  }

  const keys = [...remaining.keys()].sort()
  const radiusCells = policy.clusterRadius / 0.05
  const radius2 = radiusCells * radiusCells
  const buckets: Bucket[] = []

  for (const seedKey of keys) {
    const seed = remaining.get(seedKey)
    if (seed === undefined) continue
    remaining.delete(seedKey)

    const members: number[] = [seed]
    const stack: number[] = [seed]
    let supportSum = 0

    while (stack.length > 0) {
      const current = stack.pop()!
      const ccx = current % w
      const ccz = (current - ccx) / w

      // Observed neighbours of this frontier cell are its "support".
      if (grid.observedCount[current - 1]! >= need) supportSum++
      if (grid.observedCount[current + 1]! >= need) supportSum++
      if (grid.observedCount[current - w]! >= need) supportSum++
      if (grid.observedCount[current + w]! >= need) supportSum++

      for (const key of keys) {
        const other = remaining.get(key)
        if (other === undefined) continue
        const ocx = other % w
        const ocz = (other - ocx) / w
        const dx = ocx - ccx
        const dz = ocz - ccz
        if (dx * dx + dz * dz > radius2) continue
        remaining.delete(key)
        stack.push(other)
        members.push(other)
      }
    }

    if (members.length < policy.minCells) continue
    buckets.push({ cells: members, supportSum })
  }

  if (buckets.length === 0) return []

  // Order regions by their lowest cell index first. This is the *fixed* order the
  // tie-break needs; the path-distance ranking that follows is a stable sort on top
  // of it, so equal distances announce in a reproducible sequence.
  const measured = buckets.map((b) => {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    let sx = 0
    let sz = 0
    for (const i of b.cells) {
      const cx = i % w
      const cz = (i - cx) / w
      const px = cellCenterX(grid, cx)
      const pz = cellCenterZ(grid, cz)
      sx += px
      sz += pz
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (pz < minZ) minZ = pz
      if (pz > maxZ) maxZ = pz
    }
    const minIndex = Math.min(...b.cells)
    return {
      minIndex,
      cellCount: b.cells.length,
      centroid: { x: sx / b.cells.length, z: sz / b.cells.length },
      support: b.supportSum / b.cells.length,
      box: { minX, maxX, minZ, maxZ },
    }
  })

  measured.sort((a, b) => (a.minIndex !== b.minIndex ? a.minIndex - b.minIndex : 0))

  // A* is the expensive part, so it runs only on the regions that could plausibly
  // be announced — the nearest few — rather than on all of them.
  const withDistance = measured.map((m) => ({
    ...m,
    distance: findPath(grid, mask, agentX, agentZ, m.centroid.x, m.centroid.z).length,
  }))

  withDistance.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance
    return a.minIndex - b.minIndex
  })

  return withDistance.slice(0, policy.maxRegions).map((r) => ({
    id: `frontier-${r.minIndex}`,
    region: {
      minX: r.box.minX,
      minY: 0,
      minZ: r.box.minZ,
      maxX: r.box.maxX,
      maxY: 1.8,
      maxZ: r.box.maxZ,
    },
    centroid: r.centroid,
    cells: r.cellCount,
    distance: r.distance,
    support: r.support,
    minIndex: r.minIndex,
  }))
}

/** Announce coverage jobs from the ranked frontier regions. */
export function coverageJobs(
  grid: Grid,
  mask: Uint8Array,
  agentX: number,
  agentZ: number,
  tick: number,
  policy: CoveragePolicy = DEFAULT_COVERAGE_POLICY,
): JobRecord[] {
  const out: JobRecord[] = []
  for (const r of frontierRegions(grid, mask, agentX, agentZ, policy)) {
    // Priority rises with support: a frontier the robot can get a bearing on from
    // nearby known space is worth more than one it must travel into blind.
    const priority = Math.round(10 + r.support * 5)
    out.push(mapRegionJob(r.region, tick, priority))
  }
  return out
}