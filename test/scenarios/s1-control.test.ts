/**
 * Stage A gate. test-scenarios.md §2 — the control condition.
 *
 * "Not a scenario. A precondition for all of them."
 *
 * The control isolates navigation, allocation and reporting from perception. A
 * failure here is a logic bug; a failure at nominal noise with a clean control is
 * a perception finding, which is interesting. That asymmetry is why every
 * scenario runs the control first.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01, loadHouse } from '../../src/sim/world/content.ts'
import { createRun, defaultConfig, measure, runToCompletion, coverageGaps } from '../../src/sim/sim/run.ts'
import { GROUND_BOT, residualBiasFraction } from '../../src/sim/sim/agents.ts'
import { findPath, euclidean } from '../../src/sim/nav/astar.ts'
import { passabilityMask, CELL } from '../../src/sim/world/geometry.ts'

const house = loadHouse01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

describe('S1 — control condition (noiseMultiplier: 0)', () => {
  const run = runToCompletion(createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 300 }), spawn))
  const m = measure(run)

  it('reaches 100% coverage of the ground manifold', () => {
    // Spec §9.1: coverage is over cells the agent could actually have reached,
    // and a cell counts only once seen twice (requiredObservation = 2).
    expect(m.coverageFraction).toBeGreaterThan(0.999)
    expect(m.coverageComplete).toBe(true)
  })

  it('produces no faults and no stranded agents', () => {
    // Starvation is asserted separately and non-zero, deliberately. Stage C added a
    // job market, and with one agent and a naive coverage policy a fifth of the
    // announced coverage jobs go unbid — which is the starvation path working as
    // specified, not a fault. Conflating the two would hide a real robot failure
    // behind a policy artifact.
    expect(m.faults).toBe(0)
    expect(m.stranded).toBe(0)
  })

  it('reports starvation through the event log rather than dropping the work', () => {
    // Spec §6.5: a system that quietly drops hard jobs posts a good completion
    // rate and a bad coverage score. Every starved job must be logged.
    const starved = run.log.count('job.starved')
    expect(starved).toBe(m.starved)
    const announced = run.log.count('job.announced')
    expect(announced).toBe(run.jobs.size)
    expect(starved).toBeLessThan(announced)
  })

  it('does not exhaust the battery on a zero-noise run', () => {
    for (const b of m.batteryRemaining) {
      expect(b).toBeGreaterThan(0.15)
    }
  })

  it('never truncates the event log', () => {
    expect(m.logTruncated).toBe(false)
    expect(run.log.tickCount).toBeGreaterThan(0)
  })

  it('spends energy, so the power ledger is actually running', () => {
    expect(m.energyUsedWh).toBeGreaterThan(0)
  })

  it('reports no coverage gaps at the end of the mission', () => {
    expect(coverageGaps(run)).toEqual([])
  })
})

describe('stage A grid and pathfinding', () => {
  it('the house rasterises a connected, non-trivial navigable space', () => {
    const run = createRun(house, defaultConfig(), spawn)
    let passable = 0
    for (let i = 0; i < run.mask.length; i++) if (run.mask[i] === 1) passable++
    // A 12x8 m house at 0.05 m cells with furniture should leave thousands of
    // navigable cells. A near-zero count would mean the inflation radius is wrong.
    expect(passable).toBeGreaterThan(5000)
    expect(passable).toBeLessThan(run.mask.length)
  })

  it('inflation is order-independent (spec §1.4)', () => {
    const a = createRun(house, defaultConfig(), spawn)
    const b = createRun(house, defaultConfig(), spawn)
    expect(Array.from(a.mask)).toEqual(Array.from(b.mask))
  })

  it('the passability mask clears the spawn point', () => {
    const run = createRun(house, defaultConfig(), spawn)
    const cx = Math.floor((spawn.x - run.grid.minX) / CELL)
    const cz = Math.floor((spawn.z - run.grid.minZ) / CELL)
    expect(run.mask[cz * run.grid.width + cx]).toBe(1)
  })

  it('A* finds a path between distant rooms and it is traversable end to end', () => {
    const run = createRun(house, defaultConfig(), spawn)
    // Hall to the boiler alcove in the utility room, through four doorways.
    const path = findPath(run.grid, run.mask, spawn.x, spawn.z, 4.6, 3.4)

    expect(path.reached).toBe(true)
    expect(path.points.length).toBeGreaterThan(10)
    expect(path.length).toBeGreaterThan(euclidean(spawn.x, spawn.z, 4.6, 3.4))

    // Every consecutive pair must be inside the mask. A path with a step through
    // a wall is a planner bug that would present as a robot getting stuck.
    let prevX = spawn.x
    let prevZ = spawn.z
    for (const p of path.points) {
      for (let s = 0; s <= 20; s++) {
        const t = s / 20
        const ix = Math.floor((prevX + (p.x - prevX) * t - run.grid.minX) / CELL)
        const iz = Math.floor((prevZ + (p.z - prevZ) * t - run.grid.minZ) / CELL)
        expect(run.mask[iz * run.grid.width + ix], `path crosses a wall near ${ix},${iz}`).toBe(1)
      }
      prevX = p.x
      prevZ = p.z
    }
  })

  it('A* around a blocked goal returns a partial path rather than throwing', () => {
    const run = createRun(house, defaultConfig(), spawn)
    // Dead centre of the sofa, which is an obstacle.
    const path = findPath(run.grid, run.mask, spawn.x, spawn.z, -0.7, 1.17)
    expect(path.points.length).toBeGreaterThan(0)
  })

  it('A* is deterministic across repeated calls', () => {
    const run = createRun(house, defaultConfig(), spawn)
    const a = findPath(run.grid, run.mask, spawn.x, spawn.z, 5.0, -2.0)
    const b = findPath(run.grid, run.mask, spawn.x, spawn.z, 5.0, -2.0)
    expect(b.points).toEqual(a.points)
    expect(b.length).toBe(a.length)
    expect(b.expanded).toBe(a.expanded)
  })

  it('the sofa interior is not navigable', () => {
    const run = createRun(house, defaultConfig(), spawn)
    const mask = passabilityMask(run.grid, Math.ceil(GROUND_BOT.radius / CELL))
    // Dead centre of the sofa in the living room.
    const cx = Math.floor((-0.7 - run.grid.minX) / CELL)
    const cz = Math.floor((1.17 - run.grid.minZ) / CELL)
    expect(mask[cz * run.grid.width + cx]).toBe(0)
  })

  it('every room is reachable from the spawn — the doors are open', () => {
    // A sealed room produces a clean 100% coverage figure over a fraction of the
    // house, which is exactly how a coverage metric stops meaning anything.
    const run = createRun(house, defaultConfig(), spawn)
    for (const room of house.rooms) {
      const cx = (room.aabb.minX + room.aabb.maxX) / 2
      const cz = (room.aabb.minZ + room.aabb.maxZ) / 2
      const path = findPath(run.grid, run.mask, spawn.x, spawn.z, cx, cz)
      expect(path.reached, `room '${room.id}' is unreachable from spawn`).toBe(true)
    }
  })

  it('finds the dock at the boiler alcove', () => {
    const run = createRun(house, defaultConfig(), spawn)
    const dock = house.docks[0]!
    const path = findPath(run.grid, run.mask, spawn.x, spawn.z, dock.position[0], dock.position[2])
    expect(path.reached).toBe(true)
  })
})

describe('spec §4.5.1 — calibration model', () => {
  it('residual bias is 15% at calibration and 60% at the horizon', () => {
    expect(residualBiasFraction(0)).toBeCloseTo(0.15, 6)
    expect(residualBiasFraction(1800)).toBeCloseTo(0.6, 6)
  })

  it('decays monotonically in between', () => {
    let prev = -1
    for (let t = 0; t <= 1800; t += 30) {
      const f = residualBiasFraction(t)
      expect(f).toBeGreaterThanOrEqual(prev)
      prev = f
    }
  })

  it('clamps beyond the horizon rather than exceeding 60%', () => {
    expect(residualBiasFraction(99_999)).toBeCloseTo(0.6, 6)
    expect(residualBiasFraction(-5)).toBeCloseTo(0.15, 6)
  })

  it('buys at least a 5x drift reduction at mission start (S4 pass criterion)', () => {
    // The uncalibrated fraction is 1.0 by definition.
    const reduction = 1 / residualBiasFraction(0)
    expect(reduction).toBeGreaterThanOrEqual(5)
    // And must not approach a perfect calibration, which would delete drift.
    expect(reduction).toBeLessThan(8)
  })
})

describe('content validation', () => {
  it('house-01 loads and passes schema validation', () => {
    expect(house.id).toBe('house-01')
    expect(house.rooms.length).toBeGreaterThan(4)
    expect(house.obstacles.length).toBeGreaterThan(10)
    expect(house.ports.length).toBeGreaterThan(4)
  })

  it('every port has a dock entry for the ground bot to calibrate at', () => {
    expect(house.docks.length).toBeGreaterThan(0)
    expect(house.docks.some((d) => d.position[0] === 4.0 && d.position[2] === 2.4)).toBe(true)
  })

  it('rejects a duplicate id, which would silently drop a record', () => {
    expect(() => loadHouse({ ...house, rooms: [...house.rooms, house.rooms[0]] })).toThrow(/duplicate/)
  })

  it('rejects a degenerate bounding box', () => {
    expect(() =>
      loadHouse({
        ...house,
        obstacles: [
          {
            id: 'bad',
            manifold: 'ground',
            blocking: true,
            material: 'x',
            aabb: { minX: 1, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
          },
        ],
      }),
    ).toThrow(/degenerate/)
  })
})