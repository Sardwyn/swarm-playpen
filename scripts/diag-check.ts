/**
 * Two things that have to be true and are not obviously so.
 *
 * 1. The fault the whole product is about — yc-04, the condensation in the
 *    forward stringer void — has to be *inside* the space the renderer draws as
 *    unreachable. If it is not, the picture is arguing against itself.
 *
 * 2. The engine room's coverage has to be the same number wherever it is
 *    printed. The HUD says one thing and the diagnostic says another, and the
 *    difference has to be a difference in definition that is written down, not
 *    an accident.
 */

import { createRun, defaultConfig, step } from '../src/sim/sim/run.ts'
import { TakeRecorder, frameFromTake, regionCoverage, observedFraction } from '../src/sim/report/take.ts'
import { buildReport } from '../src/sim/report/report.ts'
import { hullBottomYSim } from '../src/sim/world/yacht-form.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../src/sim/types.ts'
import {
  yachtHouse,
  yachtTruth,
  yachtForm,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../src/sim/world/yacht-sim.ts'

const CUT_Z = 0.65

const recorder = new TakeRecorder({
  contentId: yachtHouse.id,
  truth: yachtTruth,
  everyNTicks: 10,
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
  runId: 'check',
  tick: run.tick,
  simSeconds: run.tick / 10,
  candidates: run.candidates,
  truth: run.truth,
  rooms: yachtHouse.rooms,
  coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
  regionCoverage: [],
})
const take = recorder.finish(run, report)

// ---------------------------------------------------------------- 1. the fault
const voidDef = yachtHouse.voids.find((v) => v.id === 'stringer-fwd')!
const fault = yachtTruth.anomalies.find((a) => a.id === 'yc-04')!
const u = (fault.position[0] + yachtForm.principal.loa / 2) / yachtForm.principal.loa
const floor = hullBottomYSim(yachtForm, u, CUT_Z)

console.log('the fault the product is about')
console.log('-'.repeat(78))
console.log(`void aabb          x ${voidDef.aabb.minX}..${voidDef.aabb.maxX}  y ${voidDef.aabb.minY}..${voidDef.aabb.maxY}  z ${voidDef.aabb.minZ}..${voidDef.aabb.maxZ}`)
console.log(`yc-04 at           x ${fault.position[0]}  y ${fault.position[1]}  z ${fault.position[2]}`)
console.log(`rendered floor at x=${fault.position[0]}   y ${floor.toFixed(3)}`)
console.log(`fault above the rendered floor?  ${fault.position[1] > floor ? 'yes' : 'NO — it is below the hull plating'}`)
console.log(`fault inside the authored aabb?  ${fault.position[1] > voidDef.aabb.minY && fault.position[1] < voidDef.aabb.maxY ? 'yes' : 'NO'}`)
console.log(`floor below the authored aabb?   ${floor < voidDef.aabb.minY ? 'yes — the render is deeper than the authored space' : 'no'}`)

// ------------------------------------------------------------- 2. the coverage
const last = take.frames.length - 1
const aabb = yachtHouse.rooms[0]!.aabb
const frame = frameFromTake(take, last)

let total = 0
let observed = 0
let counted = 0
const cx0 = Math.floor((aabb.minX - frame.bounds.minX) / frame.cellSize)
const cx1 = Math.floor((aabb.maxX - frame.bounds.minX) / frame.cellSize)
const cz0 = Math.floor((aabb.minZ - frame.bounds.minZ) / frame.cellSize)
const cz1 = Math.floor((aabb.maxZ - frame.bounds.minZ) / frame.cellSize)
for (let cz = Math.max(0, cz0); cz <= Math.min(frame.gridHeight - 1, cz1); cz++) {
  for (let cx = Math.max(0, cx0); cx <= Math.min(frame.gridWidth - 1, cx1); cx++) {
    const i = cz * frame.gridWidth + cx
    if (frame.passable[i] !== 1) continue
    total++
    if (frame.observed[i]! >= 2) observed++
  }
}
console.log('\ncoverage, two ways')
console.log('-'.repeat(78))
console.log(`regionCoverage over the room aabb     ${(regionCoverage(take, last, aabb) * 100).toFixed(1)}%   (${observed}/${total} cells, observed at least twice)`)
console.log(`whole boat, from the take             ${(observedFraction(take, last) * 100).toFixed(1)}%`)

// The diagnostic's way: the run's own mask and the run's own grid.
let maskTotal = 0
let maskObserved = 0
for (let cz = Math.max(0, cz0); cz <= Math.min(run.grid.height - 1, cz1); cz++) {
  for (let cx = Math.max(0, cx0); cx <= Math.min(run.grid.width - 1, cx1); cx++) {
    const i = cz * run.grid.width + cx
    if (run.mask[i] !== 1) continue
    maskTotal++
    if (run.grid.observedCount[i]! >= 2) maskObserved++
  }
}
console.log(`the diagnostic's way, from the run       ${((maskObserved / maskTotal) * 100).toFixed(1)}%   (${maskObserved}/${maskTotal})`)
console.log(`the take's way, from the last frame      ${((observed / total) * 100).toFixed(1)}%   (${observed}/${total})`)
let samePassable = 0
for (let i = 0; i < frame.passable.length; i++) {
  if ((frame.passable[i] === 1) === (run.mask[i] === 1)) samePassable++
}
console.log(`passable flags agree on ${samePassable}/${frame.passable.length} cells`)
let sameObserved = 0
for (let i = 0; i < frame.observed.length; i++) {
  if (frame.observed[i]! === run.grid.observedCount[i]!) sameObserved++
}
console.log(`observed counts agree on ${sameObserved}/${frame.observed.length} cells`)
console.log(`last recorded frame tick ${take.frames[take.frames.length - 1]!.tick}, run tick ${run.tick}`)
console.log(`grid cells in the room aabb           ${counted}`)
console.log(`passable cells in the room aabb       ${total}`)
console.log(`observed twice                        ${observed}`)

// What the grid thinks is passable over the whole ground manifold.
let gridPassable = 0
let gridObserved = 0
for (let i = 0; i < frame.observed.length; i++) {
  if (frame.passable[i] !== 1) continue
  gridPassable++
  if (frame.observed[i]! >= 2) gridObserved++
}
console.log(`passable over the whole manifold      ${gridPassable}, observed twice ${gridObserved}`)
