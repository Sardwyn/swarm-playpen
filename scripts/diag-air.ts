/**
 * The air proxy at the engine bay vent, measured.
 *
 * The blocked-vent detector gates on a rise over the field's own ambient. This
 * prints both numbers so that a miss reason can state the actual gap rather than
 * an impression of it.
 */

import { createRun, defaultConfig, step } from '../src/sim/sim/run.ts'
import { sampleField } from '../src/sim/world/fields.ts'
import { DETECTOR_THRESHOLDS } from '../src/sim/sim/run.ts'
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

const air = run.fields.air
const port = yachtHouse.ports.find((p) => p.id === 'port-vent-engine')!
const px = port.position[0]
const pz = port.position[2]
const ambient = air.baselineAt(px, pz)
const atPort = sampleField(air, px, pz)
const gate = ambient * (1 + DETECTOR_THRESHOLDS.ventRelativeRise)

console.log('the engine bay vent')
console.log('-'.repeat(72))
console.log(`port                 ${port.id} at (${px}, ${port.position[1]}, ${pz})`)
console.log(`field ambient        ${ambient.toFixed(4)}`)
console.log(`air value at the port ${atPort.toFixed(4)}`)
console.log(`rise over ambient    ${((atPort / ambient - 1) * 100).toFixed(1)}%`)
console.log(`detector gate        ${DETECTOR_THRESHOLDS.ventRelativeRise * 100}% rise  (${gate.toFixed(4)})`)
console.log(`verdict              ${atPort > gate ? 'FIRES' : 'DOES NOT FIRE'}`)

// The peak anywhere near the port, in case the agent can stand somewhere better.
let best = 0
let bestAt: [number, number] = [0, 0]
for (let x = px - 1.5; x <= px + 1.5; x += 0.05) {
  for (let z = pz - 1.5; z <= pz + 1.5; z += 0.05) {
    const v = sampleField(air, x, z)
    if (v > best) {
      best = v
      bestAt = [x, z]
    }
  }
}
console.log(`field peak nearby    ${best.toFixed(4)} at (${bestAt[0].toFixed(2)}, ${bestAt[1].toFixed(2)})`)
console.log(`still ${best > gate ? 'above' : 'below'} the gate`)
