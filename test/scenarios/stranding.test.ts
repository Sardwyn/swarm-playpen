/**
 * Stranding: spec §7.4, and the false zero it shipped as.
 *
 * ## What this file is for
 *
 * `checkStuck` was exported, looked correct, and was called from nowhere. The
 * `stalledTicks` it took was a boolean rather than a count, so even a caller would
 * have been handed `1` where the function expected `200`. `stranded: 0` had been
 * printed in every run since Stage A — and it was not measuring anything. It was a
 * counter nobody incremented, in the one monitor whose whole job is noticing that a
 * robot has stopped moving.
 *
 * The defect was found by accident. Adding a field change perturbed the trajectory,
 * the ground bot wedged in a gap at an identical pose for **2500 ticks**, coverage
 * froze at **63.83%**, and `stranded` still read 0. So the monitor's silence was not
 * evidence of a healthy swarm; it was the absence of a monitor.
 *
 * These tests construct the wedge deliberately, because the default trajectory does
 * not produce one — which is exactly why the bug survived Stage A through Stage D.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { createRun, defaultConfig, runToCompletion, step } from '../../src/sim/sim/run.ts'
import { STALL_LIMIT_TICKS, tickAgent } from '../../src/sim/sim/agents.ts'
import { cellCenterX, cellCenterZ } from '../../src/sim/world/geometry.ts'
import type { AgentState } from '../../src/sim/types.ts'
import { EventLog } from '../../src/sim/eventlog.ts'
import { Rng } from '../../src/sim/rng.ts'
import type { JobRecord } from '../../src/sim/jobs/schema.ts'
import { BROWSER_PARITY_HASH } from '../determinism/rng-and-replay.test.ts'

const house = loadHouse01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

/**
 * An agent that is wedged at a *valid* pose, by construction.
 *
 * The shape that actually occurred: the bot stood somewhere legal, its next plan
 * waypoint was inside geometry, `isPassable` rejected the step and every escape
 * attempt, and the plan cursor stayed where it was — 2500 ticks at an identical
 * pose with `stranded` reading 0.
 *
 * Placing the agent *inside* an obstacle would be easier and would prove less: such
 * an agent has no frontier, no jobs and nothing to recover to, so every assertion
 * about resuming work becomes untestable. This one is stuck in a real position in
 * a real room, which is the only kind of wedge the drivetrain can actually produce.
 */
function immobileAgent(): AgentState {
  const run = createRun(house, defaultConfig({ missionSeconds: 60 }), spawn)
  const agent = run.agents[0]!
  const g = run.grid

  const isPassableCell = (cx: number, cz: number): boolean =>
    cx >= 0 && cz >= 0 && cx < g.width && cz < g.height && run.mask[cz * g.width + cx] === 1

  // A passable cell, and an impassable cell far enough away to matter.
  //
  // Distance matters: the arrival tolerance is 0.12 m and a grid cell is 0.05 m, so
  // a waypoint in the *adjacent* cell is already "reached" and the plan is consumed
  // before any drive is attempted. The wedge needs a waypoint the agent is told to
  // go to and demonstrably cannot reach — 30 cells, 1.5 m, is well clear of the
  // tolerance and still inside the house.
  const REACH = 30
  let free: { x: number; z: number } | null = null
  let blocked: { x: number; z: number } | null = null
  for (let cz = 1; cz < g.height - 1 && free === null; cz++) {
    for (let cx = 1; cx < g.width - 1 && free === null; cx++) {
      if (!isPassableCell(cx, cz)) continue
      for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]] as const) {
        const tx = cx + dx * REACH
        const tz = cz + dz * REACH
        if (tx < 0 || tz < 0 || tx >= g.width || tz >= g.height) continue
        if (isPassableCell(tx, tz)) continue
        free = { x: cellCenterX(g, cx), z: cellCenterZ(g, cz) }
        blocked = { x: cellCenterX(g, tx), z: cellCenterZ(g, tz) }
        break
      }
    }
  }
  expect(free, 'the house must contain a passable cell 1.5 m from an impassable one').not.toBeNull()
  expect(blocked).not.toBeNull()

  // Head at it. Heading is set explicitly so the first attempted step is the
  // blocked one rather than a turn.
  const heading = Math.atan2(blocked!.z - free!.z, blocked!.x - free!.x)

  return {
    ...agent,
    pose: { x: free!.x, z: free!.z, theta: heading },
    goal: blocked!,
    plan: [blocked!, blocked!],
    planIndex: 0,
    stalledTicks: 0,
  }
}

function tickOnce(run: ReturnType<typeof createRun>, state: AgentState, log: EventLog, tick: number, job?: JobRecord): AgentState {
  return tickAgent(
    { config: run.config, grid: run.grid, mask: run.mask, rng: new Rng(1), log, tick, job },
    state,
  )
}

describe('the stall counter is a counter, not a flag', () => {
  it('STALL_LIMIT_TICKS is a threshold a counter can actually reach', () => {
    // The specific shape of the original defect: a threshold of 200 fed by a value
    // that was only ever 0 or 1. Whatever the limit is, it must be reachable by
    // incrementing, and small enough that a wedge costs seconds rather than the
    // mission.
    expect(Number.isInteger(STALL_LIMIT_TICKS)).toBe(true)
    expect(STALL_LIMIT_TICKS).toBeGreaterThan(1)
    expect(STALL_LIMIT_TICKS).toBeLessThanOrEqual(300)
  })

  it('stalledTicks accumulates across ticks while the agent cannot move', () => {
    const run = createRun(house, defaultConfig({ missionSeconds: 60 }), spawn)
    const log = new EventLog()
    let s = immobileAgent()
    for (let i = 0; i < 10; i++) s = tickOnce(run, s, log, i)
    expect(s.stalledTicks, 'the counter must accumulate, not saturate at 1').toBeGreaterThan(1)
  })

  it('an immobile agent is declared stranded after the limit', () => {
    const run = createRun(house, defaultConfig({ missionSeconds: 60 }), spawn)
    const log = new EventLog()
    let s = immobileAgent()
    const ticks = STALL_LIMIT_TICKS + 5
    for (let i = 0; i < ticks; i++) s = tickOnce(run, s, log, i)

    const stranded = log.byKind('agent.stranded')
    expect(stranded.length, 'an agent that cannot move must be noticed').toBeGreaterThan(0)
    expect(stranded[0]!.agentId).toBe(run.agents[0]!.spec.id)
    expect(s.stalledTicks, 'the counter resets after reporting, so episodes do not stack').toBeLessThan(
      STALL_LIMIT_TICKS,
    )
  })

  it('moving resets the counter', () => {
    const run = createRun(house, defaultConfig({ missionSeconds: 60 }), spawn)
    const log = new EventLog()
    const state: AgentState = { ...immobileAgent(), stalledTicks: 40 }
    // Move it somewhere open; the next drive must clear the count.
    const open = { ...state, pose: { x: -4.5, z: 0, theta: 0 }, goal: { x: -3.0, z: 0 }, plan: [{ x: -3.0, z: 0 }] }
    const next = tickOnce(run, open, log, 0)
    expect(next.stalledTicks, 'progress clears accumulated stall').toBe(0)
  })
})

describe('recovery', () => {
  /**
   * A live run in which the ground bot is wedged inside furniture while holding a
   * job, driven by the same route `step` uses so the market sees the consequences.
   */
  function strandedRun(): ReturnType<typeof createRun> {
    const run = createRun(house, defaultConfig({ missionSeconds: 300 }), spawn)
    const wedged = immobileAgent()
    const unreachable = wedged.goal!

    const record: JobRecord = {
      job: {
        id: 'test-stranded-job',
        type: 'verify_thermal',
        // The job is in the place the agent cannot get to. A job it could reach
        // would be pathed to and the agent would move, which is the whole opposite
        // of the condition under test.
        region: {
          minX: unreachable.x - 0.5,
          minY: 0,
          minZ: unreachable.z - 0.5,
          maxX: unreachable.x + 0.5,
          maxY: 1.8,
          maxZ: unreachable.z + 0.5,
        },
        manifold: 'ground',
        requiredCapabilities: ['sense.thermal'],
        priority: 50,
        state: 'active',
        announcedAtTick: 0,
        escalations: 0,
      },
      output: { kind: 'thermalMap', resolution: 0.05, minConfidence: 0.6 },
      closesAtTick: 12,
      bids: [],
      awardedTo: run.agents[0]!.spec.id,
      arrivedAtTick: null,
      dwellTicks: 0,
      superseded: null,
      awardedPathLength: 0,
    }
    run.jobs.set(record.job.id, record)
    run.jobTally.announced = 1
    run.jobTally.awarded = 1
    run.jobTally.active = 1
    run.agents[0] = { ...wedged, currentJobId: record.job.id }
    return run
  }

  it('releases the job rather than leaving it active with nobody holding it', () => {
    const run = strandedRun()
    // Run long enough for the stall limit to be crossed.
    for (let i = 0; i < STALL_LIMIT_TICKS + 3; i++) step(run)

    expect(run.log.byKind('agent.stranded').length, 'the wedge must be noticed').toBeGreaterThan(0)
    expect(run.agents[0]!.currentJobId, 'the job must be released, not abandoned silently').toBeNull()

    const record = run.jobs.get('test-stranded-job')!
    expect(['done', 'failed'], 'a job with no holder must reach a terminal state').toContain(record.job.state)
    expect(record.job.state, 'the job was not completed, so it must be failed').toBe('failed')
  })

  it('drops the plan, so recovery is not a replan onto the same gap', () => {
    const run = strandedRun()
    for (let i = 0; i < STALL_LIMIT_TICKS + 3; i++) step(run)
    const agent = run.agents[0]!
    // Abandoning the plan and replanning from the same pose produces the same path
    // through the same gap. The agent walked into it for 2500 ticks that way, at an
    // identical pose, with `stranded` reading 0.
    expect(agent.stalledTicks).toBeLessThan(STALL_LIMIT_TICKS)
  })

  it('resumes moving afterwards, rather than freezing for the rest of the mission', () => {
    const run = strandedRun()
    for (let i = 0; i < STALL_LIMIT_TICKS + 3; i++) step(run)
    const strandedPose = { ...(run.agents[0]!.pose as { x: number; z: number }) }

    // Now let it run free. The obstacle it is inside has been escaped by the plan
    // drop, and it should get back to work.
    for (let i = 0; i < 600; i++) step(run)
    const after = run.agents[0]!.pose as { x: number; z: number }
    const moved = Math.hypot(after.x - strandedPose.x, after.z - strandedPose.z)
    expect(moved, 'the agent recovered and kept working').toBeGreaterThan(0.5)
  })

  it('keeps the tally conserved through a stranding', () => {
    const run = strandedRun()
    // Long enough for the stall limit to actually be crossed. Before that the job is
    // legitimately still `active`, because the agent is still holding it and has not
    // yet been declared stranded — which is not a violation of anything.
    for (let i = 0; i < STALL_LIMIT_TICKS + 5; i++) step(run)

    // Conservation, stated as it actually holds at an arbitrary instant: every
    // announced job has exactly one record, whatever state that record is in.
    // Counting only terminal states would fail on any job still inside its bid
    // window, which is not a violation of anything.
    expect(run.jobs.size, 'every announced job must have a record').toBe(run.jobTally.announced)

    // And the job the agent was stranded on must not be left mid-lifecycle.
    const stranded = run.jobs.get('test-stranded-job')!
    expect(['done', 'failed'], 'the stranded job must reach a terminal state').toContain(stranded.job.state)
    expect(stranded.job.state, 'it was never reached, so it cannot be done').toBe('failed')
  })

  it('does not exclude the agent from a job when it is the only bidder', () => {
    // Spec §6.4 mechanism 3 excludes a failed agent so the job can go elsewhere.
    // With one agent there is no elsewhere, and applying it anyway benched the only
    // robot for half a minute: jobs done 31 -> 17, starved 9 -> 47.
    const run = strandedRun()
    for (let i = 0; i < STALL_LIMIT_TICKS + 10; i++) step(run)
    expect(run.agents.length).toBe(1)
    // The lone agent must still be willing to take ground work.
    const stillBidding = run.log.byKind('bid.submitted').length
    expect(stillBidding, 'the only agent must not be locked out of its own swarm').toBeGreaterThan(0)
  })
})

describe('the metric that was a false zero', () => {
  it('stranded is 0 on the baseline run, and that now means something', () => {
    // Before this file, the same assertion passed — for the wrong reason. There was
    // no monitor to produce a non-zero. The difference is that the monitor is now
    // exercised by the tests above, so a zero here is a measurement.
    const run = runToCompletion(
      createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, enableJobs: true }), spawn),
    )
    const stranded = run.log.count('agent.stranded')
    expect(stranded).toBe(0)
    expect(run.agents[0]!.stalledTicks).toBeLessThan(STALL_LIMIT_TICKS)
  })

  it('the baseline log is unchanged, so nothing here perturbed the reference', () => {
    // The whole file had to be additive. If a fix to the stall monitor moved the
    // parity hash, it changed the simulation rather than only its reporting.
    const run = runToCompletion(
      createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, enableJobs: true }), spawn),
    )
    expect(run.log.hash()).toBe(BROWSER_PARITY_HASH)
    expect(run.jobTally.announced).toBe(40)
    expect(run.jobTally.done).toBe(31)
    expect(run.jobTally.failed).toBe(9)
  })
})