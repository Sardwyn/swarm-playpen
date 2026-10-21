import { createRun, defaultConfig, step } from '../src/sim/sim/run.ts'
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

for (let t = 0; t < 3000; t += 250) {
  const agent = run.agents.find((a) => a.spec.id === 'inch-01')
  const inch = run.inchworms.get('inch-01')
  const pose = agent?.pose
  const kind =
    pose === undefined || pose === null
      ? 'none'
      : 'conduitId' in pose
        ? `conduit ${pose.conduitId} arc ${pose.arc.toFixed(2)}`
        : `ground (${pose.x.toFixed(2)}, ${pose.z.toFixed(2)})`
  console.log(
    `tick ${String(t).padStart(4)}  agentPose=${kind}  conduit=${
      pose !== undefined && pose !== null && 'conduitId' in pose ? pose.conduitId : '—'
    }` +
      `  inchwormState.pose=${
        inch?.pose === null || inch?.pose === undefined ? 'null' : 'set'
      }  atPort=${inch?.atPort ?? 'null'}  route=${inch?.route === null ? 'null' : 'set'}`,
  )
  for (let i = 0; i < 250; i++) step(run)
}
