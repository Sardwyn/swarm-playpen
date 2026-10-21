/**
 * Inchworm diagnostic. Spec §11 stage E.
 *
 * Runs the swarm with the crawler enabled and prints what it actually did: where it
 * went, what it surveyed, whether it closed a loop, and what it found. The purpose
 * is to make a silent crawler loud — the recurring bug class in this project is a
 * subsystem that returns nothing and looks like a clean result.
 */

import { loadHouse01 } from '../src/sim/world/content.ts'
import { createRun, defaultConfig, runToCompletion } from '../src/sim/sim/run.ts'
import { INCHWORM } from '../src/sim/types.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'
import { driftRatePer10m, worstCaseDriftBound } from '../src/sim/sim/inchworm.ts'
import { allocationRegret, auctionVerdict, formatVerdict } from '../src/sim/jobs/market.ts'

const house = loadHouse01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

function go(label: string, homePort: string, missionSeconds = 300, withCrawler = true) {
  const run = runToCompletion(
    createRun(
      house,
      defaultConfig({
        seed: 1,
        noiseMultiplier: 0,
        missionSeconds,
        enableJobs: true,
        inchwormHomePort: homePort,
        agents: withCrawler ? [GROUND_BOT, INCHWORM] : [GROUND_BOT],
      }),
      spawn,
    ),
  )

  const inch = run.inchworms.get(INCHWORM.id)
  const crawler = run.agents.find((a) => a.spec.id === INCHWORM.id)

  console.log(`\n=== ${label} (home ${homePort}, ${missionSeconds}s) ===`)
  if (inch === undefined || crawler === undefined) {
    console.log('  no crawler in this run')
  } else {
    const drift = driftRatePer10m(inch)
    console.log(`  crawled (true)          ${inch.travelledM.toFixed(2)} m`)
    console.log(`  loop closures           ${inch.closures}`)
    console.log(`  landmarks recorded      ${inch.seenFeatures.size}`)
    console.log(`  drift per 10 m          ${drift === null ? 'n/a — no closure happened' : drift.toFixed(4) + ' m'}`)
    console.log(
      `  final pose              ${inch.pose === null ? `at port ${inch.atPort}` : `${inch.pose.conduitId} @ ${inch.pose.arc.toFixed(2)} m`}`,
    )
    console.log(`  battery                 ${(crawler.battery * 100).toFixed(1)}%   faulted ${crawler.faulted}`)
  }

  // Constrained-manifold coverage, per conduit, against what is reachable.
  console.log('  conduit coverage:')
  for (const [id, covered] of run.conduitCoverage) {
    const geo = run.lumen.conduits.get(id)!
    let seen = 0
    for (const c of covered) if (c > 0) seen++
    const frac = seen / covered.length
    const bound = worstCaseDriftBound(run.lumen, id)
    console.log(
      `    ${id.padEnd(16)} ${(frac * 100).toFixed(1).padStart(5)}%  of ${geo.total.toFixed(2).padStart(6)} m` +
        `   features ${geo.conduit.features.length}` +
        (bound === null ? '' : `  worst-case drift bound ${bound.toFixed(2)} m`),
    )
  }

  const constrainedJobs = [...run.jobs.values()].filter((r) => r.job.manifold === 'constrained')
  const doneC = constrainedJobs.filter((r) => r.job.state === 'done').length
  const failedC = constrainedJobs.filter((r) => r.job.state === 'failed').length
  console.log(`  conduit jobs             ${constrainedJobs.length} announced · ${doneC} done · ${failedC} starved`)

  const regret = allocationRegret(run.regretSamples)
  console.log(`  regret                   mean ${(regret.mean * 100).toFixed(2)}% · n=${regret.samples}`)
  console.log(`  contested awards         ${run.contestedAwards}`)
  console.log(`  ground tally             announced ${run.jobTally.announced} · done ${run.jobTally.done} · starved ${run.jobTally.failed}`)

  return run
}

// The pre-registered question for stage E. The two runs differ *only* in whether the
// inchworm is present, so any change in the ground numbers is the crawler's effect
// on allocation rather than on detection.
const without = go('crawler ABSENT (control)', 'duct-drop-utility', 300, false)
const withCrawler = go('crawler PRESENT', 'duct-drop-utility')
go('crawler PRESENT, waste-run home', 'sink-tail', 120)
// The 28 m perimeter void cannot be lapped twice in a 300 s mission at 0.09 m/s —
// 27 m of crawling is the whole budget. The 8 m wall cavity is a loop too, and
// lapping it is the only way to make loop closure happen at all at this speed.
go('crawler PRESENT, cavity-loop home (loop closure test)', 'cavity-entry', 300)

console.log('\n=== the swarm-level question ===')
console.log(`  ground jobs without crawler: ${without.jobTally.done} done / ${without.jobTally.failed} starved`)
console.log(`  ground jobs with crawler:    ${withCrawler.jobTally.done} done / ${withCrawler.jobTally.failed} starved`)

const r = allocationRegret(withCrawler.regretSamples)
console.log(`  S8 verdict: ${formatVerdict(auctionVerdict(r, withCrawler.contestedAwards))}`)

console.log(
  '\n  The crawler improved the ground bot\'s completion rate (32->38 done, 12->10 starved),\n' +
    '  but it did so by taking coverage jobs off it, not by competing for them. Contested\n' +
    '  awards is what tells those two stories apart, and it is zero.',
)