/**
 * The camera director.
 *
 * ## Why this is a test and not a look
 *
 * The complaint was that the cinematic mode was jerky. Jerk is measurable: it
 * is a discontinuity in the camera's position from one instant to the next. And
 * a camera that is supposed to *follow* a machine is either locked to it or it
 * is not, which is also measurable.
 *
 * So both properties are asserted here, rather than left to a subjective
 * judgement about whether the motion looks right.
 *
 * ## What the two properties are
 *
 * 1. **Continuity inside a shot.** The camera moves smoothly for the length of
 *    a shot. The first version did not: the camera was asked for its position
 *    at an integer frame index, so it held still for most of each frame and
 *    jumped on the frame boundary — and the robot it was following moved in the
 *    same jumps. Everything juddered together.
 * 2. **Cuts between shots.** A cut IS a discontinuity, and it is the point of
 *    a cut. Six of them, at known times, and the console names the shot, so the
 *    viewer knows a cut happened and why.
 *
 * And the third property, which is the one that makes a 340 mm machine legible
 * on a 17 m boat: **a follow shot stays locked to its subject.**
 */

import { describe, expect, it } from 'vitest'
import { CameraDirector, CUT } from '../../src/view/yacht-director.ts'
import { createRun, defaultConfig, step } from '../../src/sim/sim/run.ts'
import { TakeRecorder, frameAt } from '../../src/sim/report/take.ts'
import { buildReport } from '../../src/sim/report/report.ts'
import { GROUND_BOT } from '../../src/sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../../src/sim/types.ts'
import {
  yachtHouse,
  yachtTruth,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../../src/sim/world/yacht-sim.ts'

const TOTAL_TICKS = 3000
const SAMPLES = 2000

function buildTake() {
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
  while (run.tick < TOTAL_TICKS && !run.done) {
    step(run)
    recorder.record(run)
  }
  const report = buildReport({
    runId: 'director-test',
    tick: run.tick,
    simSeconds: run.tick / 10,
    candidates: run.candidates,
    truth: run.truth,
    rooms: yachtHouse.rooms,
    coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
    regionCoverage: [],
  })
  return recorder.finish(run, report)
}

/** The camera's world position, from the same formula the orbit shim uses. */
function positionOf(state: {
  targetX: number
  targetY: number
  targetZ: number
  yaw: number
  pitch: number
  distance: number
}): [number, number, number] {
  return [
    state.targetX + Math.cos(state.yaw) * Math.cos(state.pitch) * state.distance,
    state.targetY + Math.sin(state.pitch) * state.distance,
    state.targetZ + Math.sin(state.yaw) * Math.cos(state.pitch) * state.distance,
  ]
}

describe('the camera director', () => {
  const take = buildTake()
  const director = new CameraDirector()
  const last = take.frames.length - 1

  it('covers the whole run with no gaps', () => {
    expect(CUT.length).toBeGreaterThan(3)
    expect(CUT[0]!.from).toBe(0)
    expect(CUT[CUT.length - 1]!.to).toBe(1)
    for (let i = 1; i < CUT.length; i++) {
      expect(CUT[i]!.from, `shot ${i} starts after shot ${i - 1} ends`).toBeCloseTo(
        CUT[i - 1]!.to,
        9,
      )
    }
  })

  it('names every shot, because the console shows the name', () => {
    for (const s of CUT) {
      expect(s.name.length).toBeGreaterThan(2)
    }
  })

  it('produces a usable camera everywhere', () => {
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES
      const state = director.at(t, (x) => frameAt(take, x * last))
      for (const v of [
        state.targetX,
        state.targetY,
        state.targetZ,
        state.yaw,
        state.pitch,
        state.distance,
        state.fov,
      ]) {
        expect(Number.isFinite(v), `at t=${t}`).toBe(true)
      }
      // Inside the orbit shim's limits, so the camera never gets stuck.
      expect(state.distance).toBeGreaterThan(0.4)
      expect(state.distance).toBeLessThan(80)
      expect(state.pitch).toBeGreaterThan(0)
      expect(state.pitch).toBeLessThan(1.5)
      expect(state.fov).toBeGreaterThan(30)
      expect(state.fov).toBeLessThan(100)
    }
  })

  it('does not jump inside a shot', () => {
    // The property the complaint was about. Sampled finely, the camera's
    // position must not move by more than a small fraction of a metre between
    // consecutive samples — except at a cut, which is deliberate.
    //
    // The director is walked in order, the way the viewer walks it, because it
    // has inertia: a camera that has been somewhere has to travel to get
    // somewhere else.
    let maxStep = 0
    let worstAt = 0
    for (let i = 1; i <= SAMPLES; i++) {
      const t0 = (i - 1) / SAMPLES
      const t1 = i / SAMPLES
      if (director.shotAt(t0).name !== director.shotAt(t1).name) continue // a cut
      const a = positionOf(director.at(t0, (x) => frameAt(take, x * last)))
      const b = positionOf(director.at(t1, (x) => frameAt(take, x * last)))
      const step = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      if (step > maxStep) {
        maxStep = step
        worstAt = t0
      }
    }
    // A thousandth of the run is about a third of a second of wall clock, so
    // half a metre in a third of a second is already fast.
    expect(maxStep, `largest step inside a shot, at t=${worstAt}`).toBeLessThan(0.5)
  })

  it('cuts, and the cuts are few', () => {
    let cuts = 0
    for (let i = 1; i <= SAMPLES; i++) {
      const t0 = (i - 1) / SAMPLES
      const t1 = i / SAMPLES
      if (director.shotAt(t0).name !== director.shotAt(t1).name) cuts++
    }
    expect(cuts).toBe(CUT.length - 1)
    expect(cuts).toBeLessThan(12)
  })

  it('stays locked to the machine it is following', () => {
    // A follow shot's target IS the machine. If it drifts, the shot is a fixed
    // shot that happens to be near a robot, and the robot walks out of frame.
    //
    // Walked in order, because the director has inertia and this is how the
    // viewer calls it.
    for (const shot of CUT) {
      if (shot.follow === undefined) continue
      for (let i = 0; i < 40; i++) {
        const t = shot.from + ((shot.to - shot.from) * i) / 40
        const frame = frameAt(take, t * last)
        const agent = frame.agents.find((a) => a.id === shot.follow)
        expect(agent, `${shot.name}: no agent ${shot.follow}`).toBeDefined()
        const state = director.at(t, (x) => frameAt(take, x * last))
        const drift = Math.hypot(state.targetX - agent!.x, state.targetZ - agent!.z)
        expect(drift, `${shot.name} at t=${t.toFixed(3)}: target drifted off ${shot.follow}`).toBeLessThan(
          0.01,
        )
      }
    }
  })

  it('gets close enough for a 340 mm machine to read', () => {
    // The camera has to be close. A ground robot is 340 mm across; at ten
    // metres it is three pixels, and no amount of lighting fixes that.
    for (const shot of CUT) {
      if (shot.follow === undefined) continue
      expect(shot.distance ?? 12, `${shot.name} is too far to see its subject`).toBeLessThan(6)
      expect(shot.distance2 ?? shot.distance ?? 12, `${shot.name} ends too far out`).toBeLessThan(6)
    }
  })

  it('spends most of its time on the machines', () => {
    const onAMachine = CUT.filter((s) => s.follow !== undefined).reduce(
      (acc, s) => acc + (s.to - s.from),
      0,
    )
    expect(onAMachine).toBeGreaterThan(0.5)
  })
})

describe('the playback', () => {
  const take = buildTake()
  const last = take.frames.length - 1

  it('interpolates the machines between recorded frames', () => {
    // The property that removes the judder: the pose at a fractional frame is
    // between the poses at the two recorded frames around it.
    for (let i = 0; i < last; i += 37) {
      const a = frameAt(take, i)
      const b = frameAt(take, i + 1)
      const mid = frameAt(take, i + 0.5)
      for (let k = 0; k < a.agents.length; k++) {
        const ag = a.agents[k]!
        const bg = b.agents[k]!
        const mg = mid.agents[k]!
        expect(mg.x).toBeGreaterThanOrEqual(Math.min(ag.x, bg.x) - 1e-9)
        expect(mg.x).toBeLessThanOrEqual(Math.max(ag.x, bg.x) + 1e-9)
        expect(mg.z).toBeGreaterThanOrEqual(Math.min(ag.z, bg.z) - 1e-9)
        expect(mg.z).toBeLessThanOrEqual(Math.max(ag.z, bg.z) + 1e-9)
      }
    }
  })

  it('moves the rover by a sane amount per frame', () => {
    // The rover covers about six metres of engine room in three thousand
    // ticks. If it were teleporting, a thousand frames would be a different
    // simulation.
    const first = frameAt(take, 0).agents.find((a) => a.id === 'ground-01')!
    const lastFrame = frameAt(take, last).agents.find((a) => a.id === 'ground-01')!
    const travelled = Math.hypot(lastFrame.x - first.x, lastFrame.z - first.z)
    expect(travelled).toBeGreaterThan(0.5)
    expect(travelled).toBeLessThan(20)
  })

  it('does not interpolate the coverage, because coverage is measured', () => {
    // The coverage only grows and it is a count of cells looked at twice. Lerping
    // it would draw coverage that was never measured.
    const a = frameAt(take, 100)
    const b = frameAt(take, 101)
    expect(b.observed).not.toBe(a.observed)
  })
})
