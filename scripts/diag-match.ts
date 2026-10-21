/**
 * Why a finding matched the fault it matched.
 *
 * Prints every candidate against every truth entry of the same signature: the
 * distance, the extent overlap, and whether the manifolds agree. This is the
 * question the report's matching gate is answering, and it was being answered
 * by distance alone — the content files declare an `iouMatch` threshold that
 * nothing reads, and a fault in the deckhead void was being credited to a
 * humidity reading taken on the sole of the engine room.
 */

import { createRun, defaultConfig, step } from '../src/sim/sim/run.ts'
import { extentIou } from '../src/sim/report/metrics.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../src/sim/types.ts'
import {
  yachtHouse,
  yachtTruth,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../src/sim/world/yacht-sim.ts'

const run = createRun(
  yachtHouse,
  defaultConfig({
    seed: 1,
    noiseMultiplier: 1,
    missionSeconds: 300,
    agents: [GROUND_BOT, INCHWORM, HOVER],
    inchwormHomePort: YACHT_INCHWORM_HOME,
  }),
  YACHT_SPAWN,
  yachtTruth,
)
while (run.tick < 3000 && !run.done) step(run)

console.log('CANDIDATES')
console.log('-'.repeat(104))
for (const c of run.candidates) {
  console.log(
    `${c.id.padEnd(12)} ${c.predictedClass.padEnd(16)} ${c.detectorId.padEnd(26)} ` +
      `${c.manifold.padEnd(12)} (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)})`,
  )
}

console.log('\nEVERY CANDIDATE AGAINST EVERY TRUTH ENTRY OF THE SAME SIGNATURE')
console.log('-'.repeat(104))
for (const c of run.candidates) {
  for (const a of yachtTruth.anomalies) {
    if (a.signature !== c.predictedClass) continue
    const d = Math.hypot(c.x - a.position[0], c.y - a.position[1], c.z - a.position[2])
    const iou = extentIou(c, a)
    const sameManifold = c.manifold === a.manifold
    const withinGate = d <= 3.0
    const meetsIou = iou >= yachtTruth.matchDistanceM
    console.log(
      `${c.id.padEnd(12)} -> ${a.id.padEnd(8)} ${a.class.padEnd(30)} ` +
        `d=${d.toFixed(2)}m  iou=${iou.toFixed(3)}  ` +
        `manifold ${sameManifold ? 'same ' : 'DIFF '}  ` +
        `distance-gate ${withinGate ? 'pass' : 'FAIL'}  iou-gate ${meetsIou ? 'pass' : 'FAIL'}`,
    )
  }
}

console.log('\nTHE IOU GATE ON ITS OWN WOULD REJECT')
console.log('-'.repeat(104))
for (const c of run.candidates) {
  for (const a of yachtTruth.anomalies) {
    if (a.signature !== c.predictedClass) continue
    const iou = extentIou(c, a)
    const d = Math.hypot(c.x - a.position[0], c.y - a.position[1], c.z - a.position[2])
    if (d <= 3.0 && iou < yachtTruth.matchDistanceM) {
      console.log(`${c.id} -> ${a.id}  d=${d.toFixed(2)}m iou=${iou.toFixed(3)}`)
    }
  }
}
