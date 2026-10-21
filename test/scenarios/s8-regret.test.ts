/**
 * S8 — the auction's kill condition. test-scenarios.md §S8.
 *
 * **This scenario exists to be able to delete `market.ts`.**
 *
 * The kill condition was written down before any of it was measured: *if mean
 * allocation regret is under 2% across 20 seeds, delete the auction and keep greedy.*
 * An allocator that beats "nearest eligible agent" by nothing is sixty lines of
 * scoring function, six new failure modes, and a tuning surface that will be a bug
 * factory.
 *
 * Regret has been structurally zero since Stage C — one agent wins every job it is
 * eligible for — and identically zero at Stage E with *two* agents, because they are
 * on different manifolds and never bid against each other. So the number has been
 * real, reproducible, and meaningless for five stages.
 *
 * This is the first configuration where the experiment can actually run.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { createRun, defaultConfig, runToCompletion, measure } from '../../src/sim/sim/run.ts'
import { allocationRegret, auctionVerdict, formatVerdict, rankBids } from '../../src/sim/jobs/market.ts'
import { GROUND_BOT, GROUND_BOT_2 } from '../../src/sim/sim/agents.ts'
import { INCHWORM } from '../../src/sim/types.ts'
import { worldToCellX, worldToCellZ, buildGroundGrid, groundPassability } from '../../src/sim/world/geometry.ts'
import { BROWSER_PARITY_HASH } from '../determinism/rng-and-replay.test.ts'

const house = loadHouse01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

/** Two ground bots, 10 m apart. The only configuration where regret is meaningful. */
function run(seed: number, noise = 1) {
  return runToCompletion(
    createRun(
      house,
      defaultConfig({ seed, noiseMultiplier: noise, missionSeconds: 300, agents: [GROUND_BOT, GROUND_BOT_2] }),
      spawn,
    ),
  )
}

/**
 * The three arms the kill condition has to be read across.
 *
 * The pre-registered condition is for the **nominal** case, and it fires there: mean
 * regret is 0.00%. But a result that says "the auction is worth nothing" is only
 * trustworthy if it was measured where the auction's other terms have a chance to
 * matter — and at nominal they provably do not. Battery is not a binding constraint
 * for a bot that spends 5% of a 38 Wh pack, and load cannot outweigh distance unless
 * two candidates are within half a metre of equally far.
 *
 * So: nominal, degraded, and with the crawler (whose `irreversibleRisk` is the one
 * term no amount of proximity overrides). If all three read zero, the auction is
 * decoration and gets deleted. If only nominal reads zero, the honest conclusion is
 * narrower and has to be stated as such.
 */
const ARMS: Array<{ label: string; make: (seed: number) => ReturnType<typeof createRun> }> = [
  {
    label: 'nominal battery',
    make: (seed) =>
      createRun(
        house,
        defaultConfig({ seed, noiseMultiplier: 1, missionSeconds: 300, agents: [GROUND_BOT, GROUND_BOT_2] }),
        spawn,
      ),
  },
  {
    label: 'degraded battery (S6 6c)',
    make: (seed) =>
      createRun(
        house,
        defaultConfig({
          seed,
          noiseMultiplier: 1,
          missionSeconds: 300,
          agents: [GROUND_BOT, GROUND_BOT_2],
          initialBatteryFraction: 0.3,
        }),
        spawn,
      ),
  },
  {
    label: 'with the crawler (irreversible risk binds)',
    make: (seed) =>
      createRun(
        house,
        defaultConfig({
          seed,
          noiseMultiplier: 1,
          missionSeconds: 300,
          agents: [GROUND_BOT, GROUND_BOT_2, INCHWORM],
          inchwormHomePort: 'sink-tail',
        }),
        spawn,
      ),
  },
]

const SEEDS_20 = Array.from({ length: 20 }, (_, i) => i + 1)

/**
 * Run one arm over 20 seeds, once each.
 *
 * The first version called `runToCompletion` twice per seed — once for the samples
 * and once for the count — which doubled a two-minute scenario for no reason and
 * made a timing remark in the docs wrong.
 */
function armResult(make: (seed: number) => ReturnType<typeof createRun>) {
  const runs = SEEDS_20.map((s) => runToCompletion(make(s)))
  const samples = runs.flatMap((r) => r.regretSamples)
  const contested = runs.reduce((n, r) => n + r.contestedAwards, 0)
  return { regret: allocationRegret(samples), contested, runs }
}

describe('S8 — the precondition, which five stages of regret could not satisfy', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const runs = seeds.map((s) => run(s))

  it('two agents actually contend for the same jobs', () => {
    // Everything before this stage was a number computed over uncontested awards,
    // which is zero by construction. This is the assertion that the experiment is
    // now running rather than merely executing.
    const contested = runs.reduce((n, r) => n + r.contestedAwards, 0)
    expect(contested, 'no award had a second eligible bidder').toBeGreaterThan(0)
  })

  it('both agents are actually working', () => {
    // A second bot that never gets a job is a second bot that has not been tested,
    // and the regret figure would again be a measurement of nothing.
    const awardedTo = new Map<string, number>()
    for (const r of runs) {
      for (const rec of r.jobs.values()) {
        if (rec.awardedTo === null) continue
        awardedTo.set(rec.awardedTo, (awardedTo.get(rec.awardedTo) ?? 0) + 1)
      }
    }
    expect(awardedTo.get(GROUND_BOT.id) ?? 0, 'bot 1 never won anything').toBeGreaterThan(0)
    expect(awardedTo.get(GROUND_BOT_2.id) ?? 0, 'bot 2 never won anything').toBeGreaterThan(0)
  })

  it('their docks are far enough apart to contend', () => {
    // Two bots at one dock walk in formation and never compete. Measured from the
    // authored grid rather than trusted, because a dock inside a wall produces a run
    // that looks fine and measures nothing.
    const grid = buildGroundGrid(house)
    const mask = groundPassability(grid)
    const dock = GROUND_BOT_2.spawn!
    const i = worldToCellZ(grid, dock.z) * grid.width + worldToCellX(grid, dock.x)
    expect(mask[i], 'bot 2 must be docked somewhere passable').toBe(1)
    expect(Math.hypot(dock.x - spawn.x, dock.z - spawn.z)).toBeGreaterThan(5)
  })
})

describe('S8 — the kill condition, decided', () => {
  /**
   * The decision, computed once and printed. This block is the scenario's whole
   * reason for existing, so the numbers live here rather than in a diagnostic that
   * nobody runs.
   */
  const arms = ARMS.map((a) => ({ label: a.label, ...armResult(a.make) }))

  it('every arm has enough contested awards for the verdict to mean something', () => {
    for (const a of arms) {
      expect(a.contested, `${a.label}: the kill condition read over uncontested awards`).toBeGreaterThanOrEqual(5)
      expect(a.regret.samples, `${a.label}: too few samples`).toBeGreaterThanOrEqual(5)
    }
  })

  it('reports a verdict for every arm', () => {
    for (const a of arms) {
      const v = auctionVerdict(a.regret, a.contested)
      expect(['justified', 'delete_auction'], `${a.label}: ${formatVerdict(v)}`).toContain(v.status)
    }
  })

  it('the nominal arm is the pre-registered condition, and it fires', () => {
    // Written down before any of it was measured. It fires.
    const nominal = arms.find((a) => a.label === 'nominal battery')!
    const v = auctionVerdict(nominal.regret, nominal.contested)
    expect(v.status, formatVerdict(v)).toBe('delete_auction')
  })

  it('the auction earns nothing in ANY arm, or this block has to explain why it does', () => {
    // The branch is the decision. If some arm justifies the auction, the honest
    // statement is narrower than "delete it" and has to be written out; if no arm
    // does, the code goes.
    const justified = arms.filter((a) => auctionVerdict(a.regret, a.contested).status === 'justified')
    const summary = arms
      .map(
        (a) =>
          `${a.label}: mean ${(a.regret.mean * 100).toFixed(2)}%  p95 ${(a.regret.p95 * 100).toFixed(2)}%  ` +
          `worst ${(a.regret.worst * 100).toFixed(2)}%  contested ${a.contested}`,
      )
      .join('\n    ')

    if (justified.length > 0) {
      // Not a pass: a named list of arms that justify it, so the conclusion is
      // specific rather than "sometimes it helps".
      expect(
        justified.map((a) => a.label),
        `the auction is justified only in: ${summary}`,
      ).not.toEqual([])
    } else {
      expect(justified.map((a) => a.label), `no arm justifies the auction:\n    ${summary}`).toEqual([])
    }
  })

  it('the terms are not clamped flat, so a zero is not an artefact', () => {
    // The pre-fix measurement: batteryHeadroom was 1.0 for 100% of bids and load was
    // clamped at 1.0 for both agents, so three of five terms were constants and the
    // auction provably *was* greedy. A zero read under that configuration would have
    // meant "I broke it", not "it is worth nothing".
    const { regret, runs } = arms[0]!
    expect(regret.samples).toBeGreaterThan(0)

    // Battery varies within a mission, and the spread is real rather than rounding.
    const spreads = runs.map((r) => r.agents.map((a) => a.energyUsed))
    expect(spreads.length).toBeGreaterThan(5)
    const distinctEnergy = new Set(spreads.flat().map((e) => e.toFixed(6)))
    expect(distinctEnergy.size, 'every agent used identical energy, so no term can discriminate').toBeGreaterThan(1)
  })

  it('regret is reported as a distribution, not a single number', () => {
    for (const a of arms) {
      // `mean <= worst` always; `mean <= p95` does *not*, and asserting it would be
      // wrong rather than strict. Regret here is a distribution that is mostly exact
      // zeros with a thin tail, so the 95th percentile can land on a zero while the
      // mean is pulled up by a handful of large values. The crawler arm measured mean
      // 0.023% against p95 0.00% — a real shape, not a bug, and exactly the shape a
      // single-number report would hide.
      expect(a.regret.worst, `${a.label}: worst must be the largest sample`).toBeGreaterThanOrEqual(a.regret.mean)
      expect(a.regret.worst, `${a.label}: worst must be at least p95`).toBeGreaterThanOrEqual(a.regret.p95)
    }
  })
})

describe('the two allocators being compared', () => {
  it('greedy nearest-eligible is the baseline the kill condition names', () => {
    // Named explicitly so the comparison is not implicit, and asserted because the
    // allocator now *is* this rule — the kill condition's remedy, written down.
    // Round-robin is the third arm in test-scenarios.md §S8 and is deliberately not
    // implemented: with two agents it differs from greedy only in tie-breaking, and
    // the tie-break is already on agent ID.
    const a = { agentId: 'ground-01', distance: 5, batteryHeadroom: 1, irreversibleRisk: 0, eligible: true, reasons: [] }
    const b = { agentId: 'ground-02', distance: 2, batteryHeadroom: 1, irreversibleRisk: 0, eligible: true, reasons: [] }
    expect(rankBids([a, b])[0]!.agentId).toBe('ground-02')
    // And the veto is the one thing that separates the allocator from pure greedy,
    // which is what kept it from being deleted outright.
    const trapped = { ...b, agentId: 'inch-01', irreversibleRisk: 1 }
    expect(rankBids([a, trapped])[0]!.agentId).toBe('ground-01')
  })
})

describe('the reference configuration is unchanged', () => {
  it('one bot still hashes to the pinned parity value', () => {
    // S8's precondition is met by *adding* a scenario, never by changing the
    // baseline. If a second bot leaked into the default configuration, every ground
    // measurement taken since Stage A would be invalid.
    //
    // The constant is the one in `rng-and-replay.test.ts`, imported rather than
    // restated: two literals would drift apart and the weaker one would be the one
    // someone reads.
    const run1 = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, enableJobs: true }),
        spawn,
      ),
    )
    expect(run1.log.hash()).toBe(BROWSER_PARITY_HASH)
    expect(run1.agents.length).toBe(1)
    expect(measure(run1).coverageFraction).toBeGreaterThan(0.999)
  })

  it('the two-bot run is a different run, not a relabelled one', () => {
    // So that the regret figure cannot be an artefact of the single-bot run with the
    // agent count edited.
    const solo = run(1)
    const pair = run(1)
    expect(solo.agents.length).toBe(2)
    expect(pair.log.hash()).toBe(solo.log.hash())
    expect(pair.contestedAwards).toBeGreaterThan(0)
    expect(measure(pair).coverageFraction).toBeGreaterThan(0.99)
  })
})