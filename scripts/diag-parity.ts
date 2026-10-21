import { loadHouse01 } from '../src/sim/world/content.ts'
import { createRun, defaultConfig, runToCompletion, measure } from '../src/sim/sim/run.ts'
import { allocationRegret } from '../src/sim/jobs/market.ts'
import { scoreDetections } from '../src/sim/report/metrics.ts'
import { loadAnomalies01 } from '../src/sim/world/anomalies.ts'

const house = loadHouse01()
const truth = loadAnomalies01()

// Exactly what the browser runs by default: seed 1, noise 1, jobs on.
const r = runToCompletion(
  createRun(
    house,
    defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, enableJobs: true }),
    { x: -4.5, z: 0.0, theta: 0.0 },
  ),
)
const m = measure(r)
const regret = allocationRegret(r.regretSamples)

let total = 0
let observed = 0
for (let i = 0; i < r.mask.length; i++) {
  if (r.mask[i] !== 1) continue
  total++
  if (r.grid.observedCount[i]! >= 2) observed++
}

console.log('HEADLESS REFERENCE — seed 1, noise 1, jobs on')
console.log(`  log hash                ${r.log.hash()}`)
console.log(`  tick                    ${r.tick}`)
console.log(`  coverage                ${((observed / total) * 100).toFixed(2)}%`)
console.log(`  jobs                    announced ${r.jobTally.announced} · done ${r.jobTally.done} · starved ${r.jobTally.failed}`)
console.log(`  regret                  mean ${(regret.mean * 100).toFixed(2)}% · p95 ${(regret.p95 * 100).toFixed(2)}% · n=${regret.samples}`)
const s = scoreDetections(r.candidates, truth, 'ground')
for (const row of s.metrics.byClass) {
  if (row.notAssessable) continue
  console.log(
    `  ${row.cls.padEnd(18)} ${row.precision.toFixed(2)} / ${row.recall.toFixed(2)} / ${row.f1.toFixed(2)}`,
  )
}
console.log(`  energy                  ${m.energyUsedWh.toFixed(4)} Wh`)