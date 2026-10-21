import { loadHouse01 } from '../src/sim/world/content.ts'
import { loadAnomalies01 } from '../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, runToCompletion, measure } from '../src/sim/sim/run.ts'
import { scoreDetections } from '../src/sim/report/metrics.ts'
import { allocationRegret } from '../src/sim/jobs/market.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

for (const seed of [1, 2, 3]) {
  const r = runToCompletion(
    createRun(house, defaultConfig({ seed, noiseMultiplier: 1, missionSeconds: 300 }), spawn),
  )
  const m = measure(r)
  const s = scoreDetections(r.candidates, truth, 'ground')
  const regret = allocationRegret(r.regretSamples)
  console.log(`\n--- seed ${seed} --- coverage ${(m.coverageFraction * 100).toFixed(2)}%  jobs ${r.jobs.size}  ` +
    `announced ${r.jobTally.announced} done ${r.jobTally.done} failed ${r.jobTally.failed}  ` +
    `candidates ${r.candidates.length}  regret mean ${regret.mean.toFixed(4)} n=${regret.samples}`)
  for (const row of s.metrics.byClass) {
    console.log(
      `   ${row.cls.padEnd(18)} P ${row.precision.toFixed(2)} R ${row.recall.toFixed(2)} ` +
        `tp ${row.truePositives} fp ${row.falsePositives} fn ${row.falseNegatives}`,
    )
  }
  const types: Record<string, number> = {}
  for (const j of r.jobs.values()) types[j.job.type] = (types[j.job.type] ?? 0) + 1
  console.log(`   job types: ${JSON.stringify(types)}`)
}