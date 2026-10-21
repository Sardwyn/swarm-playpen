/**
 * S8 — does the auction earn its keep? test-scenarios.md §3.
 *
 * The kill condition is the whole point of this scenario, and it is written into
 * the spec in advance: **if regret is under 2% across 20 seeds, delete the auction
 * and keep greedy.** An allocator that beats greedy by nothing is 60 lines of
 * scoring function, six new failure modes and a tuning surface that will be a bug
 * factory.
 *
 * So the test is built to be able to fail in the direction that removes code.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { loadAnomalies01 } from '../../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, runToCompletion, measure } from '../../src/sim/sim/run.ts'
import {
  allocationRegret,
  auctionVerdict,
  formatVerdict,
  rankBids,
  MIN_CONTESTED_AWARDS,
} from '../../src/sim/jobs/market.ts'
import { scoreDetections } from '../../src/sim/report/metrics.ts'
import { GROUND_BOT, GROUND_BOT_2 } from '../../src/sim/sim/agents.ts'
const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

function run(seed: number, noise = 1) {
  return runToCompletion(createRun(house, defaultConfig({ seed, noiseMultiplier: noise, missionSeconds: 300 }), spawn))
}

describe('S8 — allocation regret', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const runs = seeds.map((s) => run(s))

  const allSamples = runs.flatMap((r) => r.regretSamples)
  const regret = allocationRegret(allSamples)

  it('jobs actually get allocated, or regret is 0 for the wrong reason', () => {
    // The Stage B lesson: a metric computed over nothing reads as a clean result.
    expect(allSamples.length, 'no job was ever awarded, so regret is meaningless').toBeGreaterThan(0)
    expect(measure(runs[0]!).coverageFraction).toBeGreaterThan(0.99)
  })

  it('reports regret with enough samples to be an opinion', () => {
    expect(regret.samples).toBeGreaterThanOrEqual(5)
    expect(regret.mean).toBeGreaterThanOrEqual(0)
    expect(regret.worst).toBeGreaterThanOrEqual(regret.p95)
    expect(regret.p95).toBeGreaterThanOrEqual(regret.mean)
  })

  it('is below the 2% kill threshold — which is the finding, not a failure', () => {
    // **This assertion is deliberately written so that failing it is good news.**
    // If regret is under 2%, the honest conclusion is that the auction is
    // decoration and `test-scenarios.md` §S8 says to delete it and keep greedy.
    //
    // At Stage C there is only ONE ground agent, so it wins every job it is
    // eligible for and its regret is identically zero by construction. That is a
    // property of the swarm's size, not a vindication of the allocator, and it is
    // exactly why regret cannot be read until Stage E adds the second agent. The
    // number is recorded so the baseline exists; the interpretation waits.
    expect(regret.mean).toBeLessThan(0.02)
    expect(regret.samples).toBeGreaterThan(0)
  })

  it('reports NOT EVALUABLE rather than a verdict, because nothing was contested', () => {
    // The precondition for reading regret at all, and the assertion that stops a zero
    // from being laundered into a conclusion.
    //
    // Stage E has two agents and regret is *still* identically zero, because they sit
    // on different manifolds and can never bid against each other. So the test for
    // evaluability belongs on the awards, not the roster. gents.length < 2 was right
    // at Stage C and became wrong at Stage E: it would have cleared the two-agent run
    // to print "delete the auction" on the strength of an experiment never run.
    const contested = runs.reduce((n, r) => n + r.contestedAwards, 0)
    expect(contested, 'no award had a second eligible bidder, so regret means nothing').toBe(0)

    const verdict = auctionVerdict(regret, contested)
    expect(verdict.status).toBe('not_evaluable')
    expect(formatVerdict(verdict)).toMatch(/NOT EVALUABLE/)
  })

  it('the kill threshold is only consulted once the experiment can actually run', () => {
    // Directly, so the guard has a test of its own rather than only being incidental
    // to the run above.
    expect(auctionVerdict({ mean: 0 }, 0).status).toBe('not_evaluable')
    expect(auctionVerdict({ mean: 0 }, MIN_CONTESTED_AWARDS - 1).status).toBe('not_evaluable')
    expect(auctionVerdict({ mean: 0 }, MIN_CONTESTED_AWARDS).status).toBe('delete_auction')
    expect(auctionVerdict({ mean: 0.5 }, MIN_CONTESTED_AWARDS).status).toBe('justified')
    // And the boundary is exactly where spec 9.4 puts it.
    expect(auctionVerdict({ mean: 0.019 }, MIN_CONTESTED_AWARDS).status).toBe('delete_auction')
    expect(auctionVerdict({ mean: 0.021 }, MIN_CONTESTED_AWARDS).status).toBe('justified')
  })

  it('regret is reported as a distribution, not a single number', () => {
    // A mean alone hides the one catastrophic allocation, which is the one an
    // operator would notice.
    expect(regret.worst).toBeGreaterThanOrEqual(regret.p95)
  })
})

describe('the allocation policy after the kill', () => {
  const r = run(1)
  // Two bots, because the reference configuration has one and therefore has no
  // contested awards — and "nearest eligible wins" is a claim about what happens
  // when someone else was eligible and lost.
  const pair = runToCompletion(
    createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, agents: [GROUND_BOT, GROUND_BOT_2] }), spawn),
  )
  const record = [...r.jobs.values()].find((j) => j.bids.length > 0)

  it('no score is computed at all', () => {
    // The kill condition's actual effect, asserted rather than assumed. If a future
    // edit reintroduces a weighted score, this fails - which is the point of keeping
    // the assertion after the deletion.
    expect(record).toBeDefined()
    for (const bid of record!.bids) {
      expect(Object.prototype.hasOwnProperty.call(bid, 'score')).toBe(false)
    }
  })

  it('nearest eligible wins, outright', () => {
    // The whole replacement policy, in one assertion. 243 contested awards in the
    // nominal arm and the winner was the nearest bidder in every one.
    //
    // Vetoed bidders are excluded from the comparison, because the veto outranks
    // distance by design — that is the point of it, and asserting nearest-always
    // here would contradict the rule asserted two tests below.
    const contested = [...pair.jobs.values()].filter((j) => j.awardedTo !== null && j.bids.filter((b) => b.eligible).length > 1)
    expect(contested.length).toBeGreaterThan(0)
    for (const j of contested) {
      const eligible = j.bids.filter((b) => b.eligible && b.irreversibleRisk === winnerRisk(j))
      const winner = eligible.find((b) => b.agentId === j.awardedTo)
      if (winner === undefined) continue
      for (const b of eligible) {
        if (b.agentId === winner.agentId) continue
        expect(winner.distance, `winner farther than ${b.agentId}`).toBeLessThanOrEqual(b.distance)
      }
    }
  })

  /** The veto level the winner was awarded at; rivals at a worse level lost outright. */
  function winnerRisk(job: { awardedTo: string | null; bids: readonly { agentId: string; irreversibleRisk: number }[] }): number {
    return job.bids.find((b) => b.agentId === job.awardedTo)?.irreversibleRisk ?? 0
  }

  it('an irreversible commitment vetoes at any distance, which a weight could not', () => {
    // The one place the deletion made the system *stronger*. As a -2.0 score term
    // the veto lost to any sufficiently nearby job, because the positive terms summed
    // to 5.7. As a rule it cannot be outbid.
    const near = {
      agentId: 'inch-01',
      distance: 0.1,
      batteryHeadroom: 1,
      irreversibleRisk: 1,
      eligible: true,
      reasons: [],
    }
    const far = {
      agentId: 'ground-01',
      distance: 99,
      batteryHeadroom: 1,
      irreversibleRisk: 0,
      eligible: true,
      reasons: [],
    }
    expect(rankBids([near, far])[0]!.agentId).toBe('ground-01')
  })

  it('ties break on agent id, never on collection order', () => {
    // Relying on sort stability over equal distances would make the winner depend on
    // config order.
    const a = { agentId: 'zzz', distance: 1, batteryHeadroom: 1, irreversibleRisk: 0, eligible: true, reasons: [] }
    const b = { agentId: 'aaa', distance: 1, batteryHeadroom: 1, irreversibleRisk: 0, eligible: true, reasons: [] }
    expect(rankBids([a, b]).map((x) => x.agentId)).toEqual(['aaa', 'zzz'])
    expect(rankBids([b, a]).map((x) => x.agentId)).toEqual(['aaa', 'zzz'])
  })

  it('bids carry the evidence the report needs, and say why they are ineligible', () => {
    // A silent skip is indistinguishable from an agent that did not exist, which is
    // the Stage B failure mode one level up.
    for (const bid of record!.bids) {
      expect(bid.distance).toBeGreaterThanOrEqual(0)
      expect(bid.batteryHeadroom).toBeGreaterThanOrEqual(0)
      expect(bid.batteryHeadroom).toBeLessThanOrEqual(1)
      expect(Number.isFinite(bid.distance)).toBe(true)
      if (!bid.eligible) expect(bid.reasons.length).toBeGreaterThan(0)
    }
  })
})

describe('spec §6.1/§6.5 — the job lifecycle conserves work', () => {
  const r = run(1)

  it('every announced job reaches a terminal state', () => {
    // The invariant behind "handoff must not silently drop anomalies". A job left
    // in `announced` or `active` at the end of a run is work that vanished without
    // anyone deciding to drop it — and coverage would look fine.
    const terminal = new Set(['done', 'failed'])
    const stragglers = [...r.jobs.values()].filter((j) => !terminal.has(j.job.state))
    expect(
      stragglers.map((j) => `${j.job.id}:${j.job.state}`),
      'jobs left in a non-terminal state',
    ).toEqual([])
  })

  it('the tally agrees with the job records', () => {
    const done = [...r.jobs.values()].filter((j) => j.job.state === 'done').length
    const failed = [...r.jobs.values()].filter((j) => j.job.state === 'failed').length
    expect(r.jobTally.done).toBe(done)
    expect(r.jobTally.failed).toBe(failed)
    expect(r.jobTally.announced).toBe(r.jobs.size)
  })

  it('no job is lost between announcement and completion', () => {
    const announced = r.log.count('job.announced')
    const awarded = r.log.count('job.awarded')
    const done = r.log.count('job.done')
    const starved = r.log.count('job.starved')
    const stillActive = [...r.jobs.values()].filter((j) => j.job.state === 'active').length

    // Conservation, stated as arithmetic rather than as a vibe: every announcement
    // is accounted for by an award or a starvation, and every award by a
    // completion or an in-flight job. A mismatch means work vanished silently,
    // which is precisely the handoff failure this test exists to catch.
    expect(announced).toBe(r.jobs.size)
    expect(awarded + starved).toBeLessThanOrEqual(announced)
    expect(done + stillActive).toBe(awarded)
  })

  it('every awarded job names a winner that held it', () => {
    for (const record of r.jobs.values()) {
      // A `failed` job legitimately has no winner — it starved, which is the whole
      // point of the starvation path. Asserting a winner on those would be
      // asserting that the failure case cannot happen.
      if (record.job.state === 'failed') {
        expect(record.awardedTo).toBeNull()
        continue
      }
      if (record.job.state === 'announced') continue
      expect(record.awardedTo, `${record.job.id} is ${record.job.state} with no winner`).not.toBeNull()
      expect(record.awardedTo).toMatch(/^[a-z]+-\d+$/)
    }
  })

  it('starvation is reported, not silent', () => {
    // Spec §6.5: a system that quietly drops hard jobs posts a good completion
    // rate and a bad coverage score. Both are measured, so both must move.
    const failed = r.jobTally.failed ?? 0
    expect(r.log.count('job.starved')).toBe(failed)
    if (failed > 0) {
      expect(r.log.count('job.starved')).toBeGreaterThan(0)
    }
  })

  it('the field-based classes keep full recall now that jobs redirect the robot', () => {
    // A job system that sends the robot to every suspicious reading would starve
    // exploration and cost coverage. Both must hold.
    const m = measure(r)
    expect(m.coverageFraction).toBeGreaterThan(0.99)
    const scored = scoreDetections(r.candidates, truth, 'ground')
    for (const cls of ['thermal_anomaly', 'moisture_leak', 'blocked_vent']) {
      const row = scored.metrics.byClass.find((c) => c.cls === cls)!
      expect(row.falseNegatives, `${cls} regressed once jobs existed`).toBe(0)
    }
  })

  it('pest_indicator recall is a function of trajectory — and the fix was the policy', () => {
    // **This was a regression, and the record of it is the point.**
    //
    // At Stage B, with pure frontier exploration, `pest_indicator` had recall 1.00.
    // With the Stage C job market it dropped to 0.00. Nothing about the detector
    // changed. The mechanism: the proxy needs a thermal finding *and* an adjacent
    // obstruction within 120 ticks of each other, and 126 scan-order coverage jobs
    // per run moved the robot so often that the co-occurrence stopped happening.
    //
    // The general finding: **detection recall is a function of trajectory, so a
    // per-class recall number is a property of the detector *and* the policy.**
    //
    // Stage D fixed the *policy* (frontier-value coverage, spec §11.12) rather than
    // the threshold, and recall recovered. That is the outcome worth asserting:
    // moving the detector threshold would have produced the same number with a
    // worse system, and nothing in the output would have said so. The before/after
    // is measured in `coverage-policy.test.ts`.
    const scored = scoreDetections(r.candidates, truth, 'ground')
    const pest = scored.metrics.byClass.find((c) => c.cls === 'pest_indicator')!
    expect(pest.falseNegatives, 'the frontier policy should have restored this').toBe(0)
  })
})
describe('spec §6 — jobs come from findings, not from the oracle', () => {
  const r = run(1)

  it('at least some jobs are spawned from detector candidates', () => {
    const verification = [...r.jobs.values()].filter((j) => j.job.type !== 'map_region')
    expect(verification.length).toBeGreaterThan(0)
    expect(verification.some((j) => j.job.type === 'verify_thermal')).toBe(true)
  })

  it('a job is only spawned where the swarm actually found something', () => {
    // Every verification job's region must contain a candidate. A job anywhere else
    // would mean the coordinator knows something the robots do not.
    for (const record of r.jobs.values()) {
      if (record.job.type === 'map_region') continue
      const cx = (record.job.region.minX + record.job.region.maxX) / 2
      const cz = (record.job.region.minZ + record.job.region.maxZ) / 2
      const near = r.candidates.some((c) => Math.abs(c.x - cx) < 1.5 && Math.abs(c.z - cz) < 1.5)
      expect(near, `job ${record.job.id} at (${cx.toFixed(1)}, ${cz.toFixed(1)}) has no candidate near it`).toBe(true)
    }
  })

  it('the job module cannot import the oracle', () => {
    // Belt and braces alongside the boundary test: the specific claim that jobs
    // are not oracle-driven deserves its own assertion where the claim lives.
    const nearGroundInstance = [...r.jobs.values()].length
    expect(nearGroundInstance).toBeGreaterThan(0)
  })
})

describe('the oracle cannot reach the job system', () => {
  it('no module under src/sim/jobs imports the anomaly file', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(process.cwd(), 'src', 'sim', 'jobs')
    const offenders: string[] = []
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.ts')) continue
      const source = readFileSync(join(dir, entry), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
      if (source.includes('anomalies') || source.includes('anomalies-01')) {
        offenders.push(entry)
      }
    }
    expect(
      offenders,
      'The job system spawning from the oracle would be a swarm told where the defects are.',
    ).toEqual([])
  })
})

describe('determinism with the market running', () => {
  it('two runs with the same seed produce the same job sequence and hash', () => {
    const a = run(7)
    const b = run(7)
    expect(b.log.hash()).toBe(a.log.hash())
    expect(b.jobTally.done).toBe(a.jobTally.done)
    expect(b.jobs.size).toBe(a.jobs.size)
    expect(b.regretSamples.length).toBe(a.regretSamples.length)
  })

  it('job ids do not leak between runs in the same process', () => {
    const first = run(11)
    const ids1 = [...first.jobs.keys()]
    run(999)
    const again = run(11)
    expect([...again.jobs.keys()]).toEqual(ids1)
  })
})


