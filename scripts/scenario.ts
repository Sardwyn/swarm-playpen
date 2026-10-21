/**
 * Scenario runner. `npm run scenario`
 *
 * Prints the metrics for a named scenario with its detector IDs, per spec §8.1's
 * "detector appendix" and spec §1.5's rule that every claim carries one.
 *
 * `npm run scenario -- s1`      the control condition
 * `npm run scenario -- s2`      the noise sweep
 * `npm run scenario -- all`     everything Stage A supports
 *
 * Stage A runs the ground manifold only, so the anomaly, job and swarm metrics
 * are not yet wired to detectors. They are printed as `not yet implemented`
 * rather than as 0, because a zero reads as a measurement and would quietly
 * become a baseline that later stages are compared against.
 */

import { loadHouse01 } from '../src/sim/world/content.ts'
import { loadAnomalies01 } from '../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, measure, runToCompletion, coverageGaps } from '../src/sim/sim/run.ts'
import { scoreDetections } from '../src/sim/report/metrics.ts'
import { allocationRegret } from '../src/sim/jobs/market.ts'
import { buildReport, renderReport } from '../src/sim/report/report.ts'
import { coverage } from '../src/sim/world/geometry.ts'
import type { RunMetrics } from '../src/sim/sim/run.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}

function row(label: string, value: string, detector: string): void {
  console.log(`  ${label.padEnd(34)} ${value.padStart(14)}   ${detector}`)
}

function report(name: string, description: string, cfg: ReturnType<typeof defaultConfig>): void {
  console.log(`\n=== ${name} — ${description} ===`)
  const run = runToCompletion(createRun(house, cfg, spawn))
  const m: RunMetrics = measure(run)
  const cov = coverage(run.grid, run.mask, 2)

  console.log(
    `  seed ${cfg.seed}  noise ${cfg.noiseMultiplier}  mission ${cfg.missionSeconds}s  ` +
      `jobs ${cfg.enableJobs ? 'on' : 'OFF (detection baseline)'}`,
  )
  console.log(`  ${m.tick} ticks (${m.simSeconds.toFixed(1)} s sim)\n`)

  console.log('  spec §9.1 — coverage')
  row('coverage (ground manifold)', pct(m.coverageFraction), 'grid.coverage')
  row('observed cells', `${m.observedCells}/${m.totalCells}`, 'grid.coverage')
  row('coverage complete', String(m.coverageComplete), 'grid.coverage')
  row('uncovered cells remaining', String(coverageGaps(run).length), 'grid.gaps')
  void cov

  console.log('\n  spec §9.3 — faults')
  row('faults', String(m.faults), 'agent.faulted')
  row('stranded agents', String(m.stranded), 'agent.stranded')
  row('starved jobs', String(m.starved), 'job.starved')

  console.log('\n  spec §9.4 — job market')
  const regret = allocationRegret(run.regretSamples)
  row('jobs announced', String(run.jobTally.announced ?? 0), 'job.announced')
  row('jobs done', String(run.jobTally.done ?? 0), 'job.done')
  row('jobs starved', String(run.jobTally.failed ?? 0), 'job.starved')
  row('regret mean', `${(regret.mean * 100).toFixed(2)}%`, 'auction.regret')
  row('regret p95', `${(regret.p95 * 100).toFixed(2)}%`, 'auction.regret')
  row('regret samples', String(regret.samples), 'auction.regret')
  if (run.agents.length < 2) {
    row('regret verdict', 'not evaluable', '— one agent wins every job')
  }

  console.log('\n  spec §9.5 — energy')
  row('energy used', `${m.energyUsedWh.toFixed(4)} Wh`, 'power.ledger')
  row('battery remaining', m.batteryRemaining.map((b) => b.toFixed(3)).join(', '), 'power.ledger')
  row('Wh per anomaly', 'not yet implemented', '— needs multiple anomalies confirmed')

  console.log('\n  spec §9.2 — detection, ground manifold')
  const scored = scoreDetections(run.candidates, truth, 'ground')
  for (const d of scored.metrics.byClass) {
    if (d.notAssessable) {
      row(`${d.cls} (F1)`, 'not assessable', '— off-manifold')
      continue
    }
    const loc = d.meanLocalisationError === null ? '—' : `${d.meanLocalisationError.toFixed(2)} m`
    const iou = d.meanExtentIou === null ? '—' : d.meanExtentIou.toFixed(2)
    row(
      `${d.cls} P/R/F1`,
      `${d.precision.toFixed(2)}/${d.recall.toFixed(2)}/${d.f1.toFixed(2)}`,
      `tp ${d.truePositives} fp ${d.falsePositives} fn ${d.falseNegatives}`,
    )
    row(`  ${d.cls} loc / IoU`, `${loc} / ${iou}`, '—')
  }
  row('false positives per run', String(scored.metrics.totalFalsePositives), 'report.association')

  console.log('\n  spec §9.4 — swarm')
  row('loop closure', 'not yet implemented', '— Stage E')
  row('recombination events', 'not yet implemented', '— Stage H')

  console.log('\n  ADR-001 §1.4 — determinism')
  row('event log hash', m.logHash, 'log.hash')
  row('log truncated', String(m.logTruncated), 'log.cap')
  row('log events', String(run.log.tickCount), 'log.size')
}

const which = process.argv[2] ?? 's1'

if (which === 's1' || which === 'all') {
  report('S1', 'control condition — noiseMultiplier 0', defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 300 }))
}

if (which === 's1b' || which === 'all') {
  report('S1-nominal', 'same seed, nominal noise', defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300 }))
}

if (which === 's2' || which === 'all') {
  console.log('\n=== S2 — noise sweep ===')
  console.log('  noise   coverage    faults  energy(Wh)   log hash')
  for (const noise of [0, 0.5, 1, 2, 4, 10]) {
    const run = runToCompletion(
      createRun(house, defaultConfig({ seed: 1, noiseMultiplier: noise, missionSeconds: 300 }), spawn),
    )
    const m = measure(run)
    console.log(
      `  ${String(noise).padStart(5)}   ${pct(m.coverageFraction).padStart(8)}   ${String(m.faults).padStart(6)}  ${m.energyUsedWh.toFixed(4).padStart(10)}   ${m.logHash}`,
    )
  }
}

if (which === 'all') {
  console.log('\nStage A covers the ground manifold only. Scenarios S3-S10 need Stages B-H.')
}

if (process.argv.includes('--report')) {
  const run = runToCompletion(
    createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300 }), spawn),
  )
  const cov = coverage(run.grid, run.mask, 2)
  const report2 = buildReport({
    runId: 's1-seed1',
    tick: run.tick,
    simSeconds: run.tick / 10,
    candidates: run.candidates,
    truth,
    rooms: house.rooms,
    coverage: [
      {
        manifold: 'ground',
        fraction: cov.observedFraction,
        observedCells: cov.observedCells,
        totalCells: cov.totalCells,
      },
    ],
    regionCoverage: house.rooms.map((r) => ({ roomId: r.id, roomName: r.name, fraction: cov.observedFraction })),
    restrictToManifold: 'ground',
  })
  console.log(renderReport(report2))
}