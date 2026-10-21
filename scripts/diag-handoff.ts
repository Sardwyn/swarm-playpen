/**
 * Capability handoff diagnostic. Spec §6.4 mechanism 1.
 *
 * Reports whether the crawler detects anything in a bore, whether the escalation
 * reaches a port, and whether a thermal-capable agent corroborates it. The
 * confirmation rate is the number that decides whether putting a crawler into a pipe
 * was worth it, so it is printed rather than assumed.
 */

import { loadHouse01 } from '../src/sim/world/content.ts'
import { createRun, defaultConfig, runToCompletion } from '../src/sim/sim/run.ts'
import { loadAnomalies01 } from '../src/sim/world/anomalies.ts'
import { INCHWORM } from '../src/sim/types.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'

const house = loadHouse01()
const truth = loadAnomalies01()

console.log('=== authored constrained defects ===')
for (const a of truth.anomalies.filter((x) => x.manifold === 'constrained')) {
  console.log(
    ' ',
    a.id.padEnd(7),
    a.class.padEnd(14),
    a.conduit === undefined ? 'NOT IN A CONDUIT — unreachable by any crawler' : `${a.conduit.conduitId} @ ${a.conduit.arc} m`,
    '| expected', a.expectedDetector,
  )
}

function go(label: string, homePort: string, missionSeconds: number) {
  const run = runToCompletion(
    createRun(
      house,
      defaultConfig({
        seed: 1,
        noiseMultiplier: 0,
        missionSeconds,
        agents: [GROUND_BOT, INCHWORM],
        inchwormHomePort: homePort,
      }),
      { x: -4.5, z: 0.0, theta: 0.0 },
    ),
  )

  const suspicions = run.candidates.filter((c) => c.detectorId === 'constrained.obstruction')
  const handoffs = [...run.jobs.values()].filter((j) => j.job.handoffFrom !== undefined)
  const h = run.handoffs
  const rate = h.raised === 0 ? 'n/a' : `${((h.confirmed / h.raised) * 100).toFixed(0)}%`

  console.log(`\n=== ${label} (home ${homePort}, ${missionSeconds}s) ===`)
  console.log(`  bore obstructions authored   ${run.conduitObstructions.size} conduit(s)`)
  console.log(`  crawler suspicions raised    ${suspicions.length}`)
  for (const s of suspicions) {
    console.log(`      ${s.id} conf ${s.confidence.toFixed(2)} at ${s.x.toFixed(2)}, ${s.z.toFixed(2)}`)
  }
  console.log(`  handoffs raised              ${h.raised}`)
  for (const j of handoffs) {
    console.log(
      `      ${j.job.id.padEnd(18)} ${j.job.state.padEnd(8)} at port ${j.job.port} ` +
        `from ${j.job.handoffFrom?.conduitId}@${j.job.handoffFrom?.arc} · confirmation ${j.confirmation ?? 'undecided'}`,
    )
  }
  console.log(`  confirmed / unconfirmed      ${h.confirmed} / ${h.unconfirmed}   rate ${rate}`)
  console.log(`  crawler crawled              ${run.inchworms.get(INCHWORM.id)?.travelledM.toFixed(2) ?? 'n/a'} m`)
  return run
}

go('utility room (perimeter void)', 'duct-drop-utility', 300)
go('kitchen sink (40 mm dead end)', 'sink-tail', 120)
go('wall cavity', 'cavity-entry', 300)