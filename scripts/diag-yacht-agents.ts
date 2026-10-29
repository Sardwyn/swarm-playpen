/**
 * What each machine actually does on this vessel.
 *
 * The demo's activity labels have to say something true, and the camera shots
 * have to frame something worth framing. Both need to know where the three
 * machines spend their time and what they are working on.
 *
 *     npx vite-node scripts/diag-yacht-agents.ts
 */

import { createRun, defaultConfig, step } from '../src/sim/sim/run.ts'
import { TakeRecorder, frameAt } from '../src/sim/report/take.ts'
import { buildReport } from '../src/sim/report/report.ts'
import { yachtHouse, yachtTruth, YACHT_SPAWN, YACHT_INCHWORM_HOME } from '../src/sim/world/yacht-sim.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'
import { INCHWORM, HOVER } from '../src/sim/types.ts'

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

const recorder = new TakeRecorder({
  contentId: yachtHouse.id,
  truth: yachtTruth,
  everyNTicks: 3,
})
while (!run.done && run.tick < 3000) {
  step(run)
  recorder.record(run)
}
const take = recorder.finish(
  run,
  buildReport({
    runId: 'diag',
    tick: run.tick,
    simSeconds: run.tick / 10,
    candidates: run.candidates,
    truth: run.truth,
    rooms: yachtHouse.rooms,
    coverage: [],
    regionCoverage: [],
  }),
)

type Summary = {
  id: string
  cls: string
  x: [number, number]
  y: [number, number]
  z: [number, number]
  jobs: Map<string, number>
  faulted: number
  battery: number[]
}

const summaries = new Map<string, Summary>()
const frames = take.frames
for (let i = 0; i < frames.length; i++) {
  const f = frameAt(take, i)
  for (const a of f.agents) {
    let s = summaries.get(a.id)
    if (s === undefined) {
      s = {
        id: a.id,
        cls: a.cls,
        x: [Infinity, -Infinity],
        y: [Infinity, -Infinity],
        z: [Infinity, -Infinity],
        jobs: new Map(),
        faulted: 0,
        battery: [],
      }
      summaries.set(a.id, s)
    }
    s.x[0] = Math.min(s.x[0], a.x)
    s.x[1] = Math.max(s.x[1], a.x)
    s.y[0] = Math.min(s.y[0], a.y)
    s.y[1] = Math.max(s.y[1], a.y)
    s.z[0] = Math.min(s.z[0], a.z)
    s.z[1] = Math.max(s.z[1], a.z)
    s.battery.push(a.battery)
    if (a.faulted) s.faulted++
    const key = a.currentJobType ?? '(none)'
    s.jobs.set(key, (s.jobs.get(key) ?? 0) + 1)
  }
}

const fmt = (r: [number, number]): string => `${r[0].toFixed(2)}..${r[1].toFixed(2)}`
for (const s of summaries.values()) {
  const jobs = [...s.jobs.entries()].sort((a, b) => b[1] - a[1])
  console.log(`${s.id} (${s.cls})`)
  console.log(`  x ${fmt(s.x)}   y ${fmt(s.y)}   z ${fmt(s.z)}`)
  console.log(`  jobs ${jobs.map(([k, v]) => `${k}:${v}`).join('  ')}`)
  console.log(`  faulted frames ${s.faulted}/${s.battery.length}   battery ${(Math.min(...s.battery) * 100).toFixed(0)}..${(Math.max(...s.battery) * 100).toFixed(0)}%`)
}

// Where does the run think the findings are?
console.log('\nfinal frame findings')
const last = frameAt(take, frames.length - 1)
for (const f of last.findings) {
  console.log(`  ${f.id}  ${f.detectorId}  @ ${f.x.toFixed(2)}, ${f.y.toFixed(2)}, ${f.z.toFixed(2)}`)
}
console.log('\ntruth')
for (const t of yachtTruth.anomalies) {
  console.log(`  ${t.id}  ${t.class}  @ ${t.position.join(', ')}  ${t.signature}`)
}
