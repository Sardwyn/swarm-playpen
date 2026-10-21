import { createRun, defaultConfig, step } from '../src/sim/sim/run.ts'
import { TakeRecorder, frameAt } from '../src/sim/report/take.ts'
import { buildReport } from '../src/sim/report/report.ts'
import { CameraDirector, CUT } from '../src/view/yacht-director.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../src/sim/types.ts'
import {
  yachtHouse,
  yachtTruth,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../src/sim/world/yacht-sim.ts'

const recorder = new TakeRecorder({
  contentId: yachtHouse.id,
  truth: yachtTruth,
  everyNTicks: 3,
})
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
while (run.tick < 3000 && !run.done) {
  step(run)
  recorder.record(run)
}
const report = buildReport({
  runId: 'd',
  tick: run.tick,
  simSeconds: run.tick / 10,
  candidates: run.candidates,
  truth: run.truth,
  rooms: yachtHouse.rooms,
  coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
  regionCoverage: [],
})
const take = recorder.finish(run, report)
const last = take.frames.length - 1
const director = new CameraDirector()

console.log('frame agent ids:', frameAt(take, 0).agents.map((a) => `${a.id}/${a.cls}`).join(' '))

for (const shot of CUT) {
  if (shot.follow === undefined) continue
  const t = (shot.from + shot.to) / 2
  const frame = frameAt(take, t * last)
  const agent = frame.agents.find((a) => a.id === shot.follow)
  const state = director.at(t, (x) => frameAt(take, x * last))
  console.log(
    `${shot.name.padEnd(22)} follow=${shot.follow.padEnd(10)} ` +
      `agent=${agent === undefined ? 'MISSING' : `(${agent.x.toFixed(2)}, ${agent.z.toFixed(2)})`} ` +
      `target=(${state.targetX.toFixed(2)}, ${state.targetZ.toFixed(2)})`,
  )
}

// How fast does the yaw swing?
console.log('\nyaw swing inside the rover shot')
let maxStep = 0
let worst = 0
for (let i = 1; i <= 2000; i++) {
  const t0 = (i - 1) / 2000
  const t1 = i / 2000
  if (director.shotAt(t0).name !== director.shotAt(t1).name) continue
  if (t0 < 0.12 || t0 > 0.33) continue
  const a = director.at(t0, (x) => frameAt(take, x * last))
  const b = director.at(t1, (x) => frameAt(take, x * last))
  const step = Math.abs(b.yaw - a.yaw)
  if (step > maxStep) {
    maxStep = step
    worst = t0
  }
}
console.log(`largest yaw step ${maxStep.toFixed(4)} rad at t=${worst.toFixed(4)}`)

// And the heading itself.
console.log('\nrover heading step')
const f0 = frameAt(take, 100 * last)
const f1 = frameAt(take, 100 * last + 0.02)
const a0 = f0.agents.find((a) => a.id === 'ground-01')!
const a1 = f1.agents.find((a) => a.id === 'ground-01')!
console.log(`heading ${a0.heading.toFixed(3)} -> ${a1.heading.toFixed(3)}`)
