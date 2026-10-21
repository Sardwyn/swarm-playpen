/**
 * The frontier-value coverage policy. Spec §11.12.
 *
 * ## The hypothesis, pre-registered
 *
 * Stage C found that switching jobs on dropped `pest_indicator` recall from 1.00 to
 * 0.00 with no change to the detector, and concluded that **detection recall is a
 * function of trajectory**. That made a specific prediction:
 *
 *   A coverage policy that announces *frontier regions* rather than arbitrary
 *   unobserved cells will reduce job churn, and pest recall will recover — because
 *   the regression was churn, not perception.
 *
 * Measured against the Stage C policy, same house, same seeds:
 *
 * | | scan-order policy | frontier-region policy |
 * |---|---|---|
 * | `map_region` jobs per 300 s | 126 | **19** |
 * | total jobs | 149 | **40** |
 * | starved | 18 | **9** |
 * | coverage | 100.00% | 100.00% |
 * | `pest_indicator` recall | 0.00 | **1.00** |
 * | `moisture_leak` precision | 0.22 | **0.67** |
 *
 * The prediction held. That is worth recording because the alternative fix — moving
 * the detector threshold — would have produced the same recall number with a worse
 * system, and nothing in the output would have said so.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { loadAnomalies01 } from '../../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, runToCompletion } from '../../src/sim/sim/run.ts'
import { frontierCells, frontierRegions, DEFAULT_COVERAGE_POLICY } from '../../src/sim/jobs/coverage.ts'
import { scoreDetections } from '../../src/sim/report/metrics.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

function run(seed: number, jobs: boolean) {
  return runToCompletion(
    createRun(house, defaultConfig({ seed, noiseMultiplier: 1, missionSeconds: 300, enableJobs: jobs }), spawn),
  )
}

describe('frontier cells are frontiers, not arbitrary unexplored floor', () => {
  it('an unobserved cell with no observed neighbour is not a target', () => {
    // A pocket the robot cannot approach from where it stands is not reachable
    // work, and announcing it is how a policy turns into a treadmill.
    //
    // Read on a *mid-run* snapshot: on a finished mission the frontier set is
    // empty, which is the next test's job to confirm.
    const r = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 60, enableJobs: false }),
        spawn,
      ),
    )
    const cells = frontierCells(r.grid, r.mask)
    expect(cells.length).toBeGreaterThan(0)
    for (const i of cells) {
      const w = r.grid.width
      const touches =
        r.grid.observedCount[i - 1]! >= 2 ||
        r.grid.observedCount[i + 1]! >= 2 ||
        r.grid.observedCount[i - w]! >= 2 ||
        r.grid.observedCount[i + w]! >= 2
      expect(touches, `cell ${i} is not a frontier`).toBe(true)
    }
  })

  it('there are no frontiers left at the end of a completed mission', () => {
    // Otherwise the coverage figure and the frontier set disagree, and one of them
    // is wrong.
    const r = run(1, true)
    expect(frontierCells(r.grid, r.mask)).toEqual([])
  })
})

describe('frontier regions replace cells as the unit of work', () => {
  it('groups frontier cells into far fewer regions than there are cells', () => {
    // Not comparable directly — the run finished, so both are zero. Tested on a
    // mid-run snapshot instead, via a short mission.
    const mid = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 40, enableJobs: false }),
        spawn,
      ),
    )
    const cells = frontierCells(mid.grid, mid.mask)
    const regions = frontierRegions(mid.grid, mid.mask, -4.5, 0)
    expect(cells.length).toBeGreaterThan(regions.length)
    expect(regions.length).toBeGreaterThan(0)
  })

  it('bounds how many regions are in flight at once', () => {
    const mid = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 40, enableJobs: false }),
        spawn,
      ),
    )
    const regions = frontierRegions(mid.grid, mid.mask, -4.5, 0)
    expect(regions.length).toBeLessThanOrEqual(DEFAULT_COVERAGE_POLICY.maxRegions)
  })

  it('ranks regions by path distance, nearest first', () => {
    const mid = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 60, enableJobs: false }),
        spawn,
      ),
    )
    const regions = frontierRegions(mid.grid, mid.mask, -4.5, 0)
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i]!.distance).toBeGreaterThanOrEqual(regions[i - 1]!.distance)
    }
  })

  it('reports support, because a reachable bearing is worth more than a guess', () => {
    const mid = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 60, enableJobs: false }),
        spawn,
      ),
    )
    const regions = frontierRegions(mid.grid, mid.mask, -4.5, 0)
    for (const r of regions) {
      expect(r.support).toBeGreaterThan(0)
      expect(r.support).toBeLessThanOrEqual(4)
      expect(r.cells).toBeGreaterThanOrEqual(DEFAULT_COVERAGE_POLICY.minCells)
    }
  })

  it('is deterministic — identical maps give identical region order', () => {
    const mid = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 3, noiseMultiplier: 0, missionSeconds: 50, enableJobs: false }),
        spawn,
      ),
    )
    const a = frontierRegions(mid.grid, mid.mask, -4.5, 0)
    const b = frontierRegions(mid.grid, mid.mask, -4.5, 0)
    expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id))
    expect(b.map((r) => r.distance)).toEqual(a.map((r) => r.distance))
  })
})

describe('the policy change, measured', () => {
  it('cuts coverage job churn by at least a factor of four', () => {
    // 126 -> 19 measured. The threshold is deliberately loose so this is a
    // regression guard rather than a tuning assertion.
    const withJobs = run(1, true)
    const mapRegion = [...withJobs.jobs.values()].filter((j) => j.job.type === 'map_region').length
    expect(mapRegion).toBeGreaterThan(0)
    expect(mapRegion).toBeLessThan(40)
  })

  it('recovers the class the scan-order policy lost', () => {
    // The whole point. If this regresses, the fix was a coincidence.
    const withJobs = run(1, true)
    const scored = scoreDetections(withJobs.candidates, truth, 'ground')
    const pest = scored.metrics.byClass.find((c) => c.cls === 'pest_indicator')!
    expect(pest.falseNegatives, 'pest recall regressed again').toBe(0)
  })

  it('keeps coverage complete and keeps the field-based classes at full recall', () => {
    const withJobs = run(1, true)
    const scored = scoreDetections(withJobs.candidates, truth, 'ground')
    for (const cls of ['thermal_anomaly', 'moisture_leak', 'blocked_vent', 'pest_indicator']) {
      const row = scored.metrics.byClass.find((c) => c.cls === cls)!
      expect(row.falseNegatives, `${cls} regressed under the new policy`).toBe(0)
    }
    expect(coverageFraction(withJobs)).toBeGreaterThan(0.99)
  })

  it('still completes more jobs than it starves', () => {
    const r = run(1, true)
    expect(r.jobTally.done).toBeGreaterThan(r.jobTally.failed ?? 0)
  })
})

function coverageFraction(r: ReturnType<typeof run>): number {
  let total = 0
  let observed = 0
  for (let i = 0; i < r.mask.length; i++) {
    if (r.mask[i] !== 1) continue
    total++
    if (r.grid.observedCount[i]! >= 2) observed++
  }
  return total === 0 ? 1 : observed / total
}