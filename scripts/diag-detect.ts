import { loadHouse01 } from '../src/sim/world/content.ts'
import { loadAnomalies01 } from '../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, runToCompletion, DETECTOR_THRESHOLDS } from '../src/sim/sim/run.ts'
import { scoreDetections } from '../src/sim/report/metrics.ts'
import { coverage } from '../src/sim/world/geometry.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

const run = runToCompletion(
  createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300 }), spawn),
)
const cov = coverage(run.grid, run.mask, 2)

console.log(`candidates: ${run.candidates.length}`)
const byDet: Record<string, number> = {}
for (const c of run.candidates) byDet[c.detectorId] = (byDet[c.detectorId] ?? 0) + 1
console.log('by detector:', byDet)
const byClass: Record<string, number> = {}
for (const c of run.candidates) byClass[c.predictedClass] = (byClass[c.predictedClass] ?? 0) + 1
console.log('by class:', byClass)

console.log('\nground-manifold truth instances:')
for (const a of truth.anomalies.filter((a) => a.manifold === 'ground')) {
  console.log(`  ${a.id} ${a.class.padEnd(18)} at (${a.position[0]}, ${a.position[2]}) strength ${a.sourceStrength}`)
}
console.log('off-manifold count:', truth.anomalies.filter((a) => a.manifold !== 'ground').length)

for (const noise of [0, 1]) {
  const r = runToCompletion(
    createRun(house, defaultConfig({ seed: 1, noiseMultiplier: noise, missionSeconds: 300 }), spawn),
  )
  const s = scoreDetections(r.candidates, truth, 'ground')
  console.log(`\n--- noise ${noise}: tp ${s.metrics.totalTruePositives} fp ${s.metrics.totalFalsePositives} of ${r.candidates.length} candidates`)
  for (const m of s.metrics.byClass) {
    console.log(
      `  ${m.cls.padEnd(18)} P ${m.precision.toFixed(2)} R ${m.recall.toFixed(2)} F1 ${m.f1.toFixed(2)} ` +
        `tp ${m.truePositives} fp ${m.falsePositives} fn ${m.falseNegatives} ` +
        `loc ${m.meanLocalisationError === null ? '  —  ' : m.meanLocalisationError.toFixed(2)} ` +
        `${m.notAssessable ? 'NOT-ASSESSABLE' : ''}`,
    )
  }
}

console.log(`\nthresholds: ${JSON.stringify(DETECTOR_THRESHOLDS)}`)
void cov