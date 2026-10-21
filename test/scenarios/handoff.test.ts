/**
 * Capability handoff. Spec §6.4 mechanism 1 — the second half of Stage E's gate.
 *
 * ## The shape of the thing under test
 *
 * The inchworm has `sense.depth` and nothing else. So the only finding it can raise
 * is geometric — something is in the bore — and it cannot say what. Every suspicion
 * it publishes is therefore below `CONFIDENCE_MIN` by construction, and cannot be
 * serviced where it was raised, because nothing with `sense.thermal` can reach 8 m
 * into a 70 mm pipe.
 *
 * So each suspicion is escalated to the nearest reachable port and a ground bot is
 * dispatched there to sample it. That is the mechanism; this file checks that it
 * exists, that it is driven by capability rather than by convenience, and — the part
 * that matters — that when it comes back empty the report says so.
 *
 * ## The measured result, stated up front
 *
 * **The confirmation rate on the authored content is 0%.** That is not a tuning
 * failure and it is not currently a broken test; the mechanism runs and the jobs
 * complete. It is structural, for two independent reasons:
 *
 * 1. The corroboration test reads *thermal* candidates, and in-bore obstructions are
 *    authored with `sourceStrength: 0` because an obstruction is geometry, not a heat
 *    source. They produce no thermal signature anywhere.
 * 2. The only other signal a blockage produces is stagnant air — the VOC proxy — and
 *    `detectBlockedVent` only checks it at **air registers**. `Port.kind` marks all
 *    five conduit entries as `conduit_entry`, deliberately, because inferring
 *    "ventilation register" from "one side is ground" made the detector fire at a
 *    boiler flue penetration one metre from a real blocked vent.
 *
 * So the honest reading is: **a suspicion can be escalated and worked, but on this
 * content it can essentially never be corroborated from outside the pipe.** Whether a
 * conduit entry should count as a partial air register is a real open question, and
 * it is recorded as one rather than resolved by making the number look better.
 *
 * `proves the corroboration test can confirm when the evidence is there` exists so
 * that the 0% above is known to be about the world rather than about the code.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { loadAnomalies01 } from '../../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, runToCompletion, step, stepMarket } from '../../src/sim/sim/run.ts'
import { buildLumenGraph } from '../../src/sim/world/lumen.ts'
import { buildConduitObstructions, scanBore, BORE_END_MARGIN } from '../../src/sim/world/bore.ts'
import { detectBoreObstruction, createConstrainedDetectorState } from '../../src/sim/sim/constrained.ts'
import { INCHWORM, CONDUIT_SUSPICION_CONFIDENCE, isLumenPose } from '../../src/sim/types.ts'
import { CONFIDENCE_MIN } from '../../src/sim/report/report.ts'
import { GROUND_BOT } from '../../src/sim/sim/agents.ts'
import { BROWSER_PARITY_HASH } from '../determinism/rng-and-replay.test.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const graph = buildLumenGraph(house.conduits)
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

function runCrawler(homePort: string, missionSeconds: number) {
  return runToCompletion(
    createRun(
      house,
      defaultConfig({
        seed: 1,
        noiseMultiplier: 0,
        missionSeconds,
        agents: [GROUND_BOT, INCHWORM],
        inchwormHomePort: homePort,
      }),
      spawn,
    ),
  )
}

/**
 * A run stepped only as far as its first escalation, and still live.
 *
 * Needed because `step()` is a no-op on a finished run, so a completed mission
 * cannot be re-entered to change an outcome. The corroboration tests change what
 * evidence exists and then ask the market to re-read it, which a finished run will
 * not do.
 */
function steppedUntilHandoff() {
  const run = createRun(
    house,
    defaultConfig({
      seed: 1,
      noiseMultiplier: 0,
      missionSeconds: 300,
      agents: [GROUND_BOT, INCHWORM],
      inchwormHomePort: 'duct-drop-utility',
    }),
    spawn,
  )
  for (let t = 0; t < 3000 && !run.done; t++) {
    step(run)
    if (run.handoffs.raised > 0) break
  }
  if (run.handoffs.raised === 0) throw new Error('no escalation was raised within the mission')
  return run
}

// ---------------------------------------------------------------------------
// The missing capability. Spec §3.2
// ---------------------------------------------------------------------------

describe('the constraint that makes handoff necessary', () => {
  it('the inchworm has no thermal sensor, so it cannot confirm anything', () => {
    expect(INCHWORM.capabilities).not.toContain('sense.thermal')
    expect(INCHWORM.capabilities).not.toContain('sense.rgb')
    // Also absent, and deliberately: an earlier version granted it. With a scalar
    // sensor the crawler could partly corroborate its own findings, the escalation
    // would never have fired, and the constraint would have been quietly removed.
    expect(INCHWORM.capabilities).not.toContain('sense.humidity')
  })

  it('its suspicions are published below the acceptance threshold, and that is checked', () => {
    // A comment asserting the relationship would not survive a future edit that
    // raises the constant. Raising it would silence the crawler's whole contribution
    // while *looking* like an improvement: more precision, same recall.
    expect(CONDUIT_SUSPICION_CONFIDENCE).toBeLessThan(CONFIDENCE_MIN)
  })

  it('the ground bot does have the capability, which is what makes escalation possible', () => {
    expect(GROUND_BOT.capabilities).toContain('sense.thermal')
  })
})

// ---------------------------------------------------------------------------
// The bore scan. Spec §3.2, `sense.depth` only
// ---------------------------------------------------------------------------

describe('the bore scan', () => {
  const voidGeo = graph.conduits.get('void-perimeter')!

  it('reads clear to the sensor limit in an empty bore', () => {
    const scan = scanBore(voidGeo, [], 3, 1, 0.4, 0)
    expect(scan.range).toBeCloseTo(0.4, 6)
    expect(scan.obstructed).toBe(false)
  })

  it('reads short when something is ahead, and says so', () => {
    const scan = scanBore(voidGeo, [{ arc: 5, anomalyId: 'ob-01' }], 4.7, 1, 0.4, 0)
    expect(scan.range).toBeCloseTo(0.3, 6)
    expect(scan.obstructed).toBe(true)
  })

  it('does not report the end of a pipe as a blockage', () => {
    // The single most likely way this detector lies: a crawler finishing its run
    // sees the bore open out and reports an obstruction at every dead end. That
    // would hand off once per conduit and make the confirmation rate meaningless.
    const waste = graph.conduits.get('waste-sink')!
    const scan = scanBore(waste, [], waste.total - 0.2, 1, 0.4, 0)
    expect(scan.toEnd).toBeLessThan(0.4)
    expect(scan.obstructed, 'the end of the bore is not a defect').toBe(false)
  })

  it('survives noise at the far end of a bore', () => {
    // The margin has to sit outside the noise, or a noisy reading at a pipe's end
    // reads as a blockage. Same class of decision as the 118 K magnitude gate that
    // silenced a detector for a whole stage.
    const waste = graph.conduits.get('waste-sink')!
    for (let n = 0; n <= 20; n++) {
      const scan = scanBore(waste, [], waste.total - 0.2, 1, 0.4, (n / 20 - 0.5) * 2 * BORE_END_MARGIN)
      expect(scan.obstructed, `false positive at noise offset ${n}`).toBe(false)
    }
  })

  it('is direction-aware, so a crawler does not sense what is behind it', () => {
    const scan = scanBore(voidGeo, [{ arc: 5, anomalyId: 'ob-01' }], 6, -1, 0.4, 0)
    expect(scan.obstructed, 'an obstruction behind the agent is not ahead').toBe(false)
  })

  it('ignores an obstruction it is already level with', () => {
    // Range 0 is indistinguishable from being inside something, and would fire the
    // detector at every arc it passes through.
    const scan = scanBore(voidGeo, [{ arc: 5, anomalyId: 'ob-01' }], 5, 1, 0.4, 0)
    expect(scan.obstructed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

describe('the in-bore obstruction detector', () => {
  const geo = graph.conduits.get('void-perimeter')!

  it('emits a suspicion when the crawler approaches an obstruction', () => {
    const state = createConstrainedDetectorState()
    const found = detectBoreObstruction(
      INCHWORM.id, 100, state, geo, [{ arc: 6.5, anomalyId: 'ob-01' }], 6.2, 1, 0.4, 0,
    )
    expect(found).not.toBeNull()
    expect(found!.conduitId).toBe('void-perimeter')
    expect(found!.arc).toBe(6.5)
    expect(found!.confidence).toBe(CONDUIT_SUSPICION_CONFIDENCE)
  })

  it('reports one obstruction once, however many readings it takes', () => {
    // Episode tracking, and the difference between "a blockage" and "eleven
    // sightings of a blockage".
    const state = createConstrainedDetectorState()
    const obs = [{ arc: 6.5, anomalyId: 'ob-01' }]
    let raised = 0
    for (let arc = 6.1; arc <= 6.5; arc += 0.02) {
      if (detectBoreObstruction(INCHWORM.id, 0, state, geo, obs, arc, 1, 0.4, 0) !== null) raised++
    }
    expect(raised, 'one blockage is one finding').toBe(1)
  })

  it('stays silent in a clear bore', () => {
    // The negative control. A detector that fires everywhere is not a detector, and
    // one that fires nowhere is indistinguishable from one that is not running —
    // which is why the positive test above exists at all.
    const state = createConstrainedDetectorState()
    expect(detectBoreObstruction(INCHWORM.id, 0, state, geo, [{ arc: 6.5, anomalyId: 'ob-01' }], 1.0, 1, 0.4, 0)).toBeNull()
  })
})

describe('obstruction geometry comes from the oracle, and only the oracle', () => {
  const built = buildConduitObstructions(truth)

  it('carries every authored conduit defect, and nothing else', () => {
    const authored = truth.anomalies.filter((a) => a.conduit !== undefined)
    expect(authored.length).toBeGreaterThan(0)
    let total = 0
    for (const list of built.values()) total += list.length
    expect(total, 'every authored in-bore defect must be geometry').toBe(authored.length)
  })

  it('leaves defects with no conduit unreachable rather than inventing a position', () => {
    // `bv-02`, `bv-03`, `ml-04` and `pi-02` are constrained-manifold defects with no
    // conduit target. Nothing can reach or see them, and they will score zero recall.
    // That is the `structural_crack` finding again, and it is reported rather than
    // fixed by moving the content somewhere a detector happens to look.
    const orphans = truth.anomalies.filter((a) => a.manifold === 'constrained' && a.conduit === undefined)
    expect(orphans.length, 'the house still has unreachable constrained defects').toBeGreaterThan(0)
    for (const o of orphans) {
      for (const list of built.values()) {
        expect(list.some((x) => x.anomalyId === o.id), `${o.id} must not be geometry`).toBe(false)
      }
    }
  })

  it('is a world-building step, and it is deterministic', () => {
    // The relationship is the same one `buildFields` has to the oracle. The line that
    // matters is held by `test/boundary/no-ground-truth-leak.test.ts`; this only
    // records why that is the right place for it to be held.
    //
    // Determinism rather than identity: two calls return two Maps, and comparing them
    // by reference would fail for reasons that have nothing to do with the detector.
    const a = buildConduitObstructions(truth)
    const b = buildConduitObstructions(truth)
    expect([...a.entries()]).toEqual([...b.entries()])
  })
})

// ---------------------------------------------------------------------------
// The escalation. Spec §6.4 mechanism 1
// ---------------------------------------------------------------------------

describe('escalation', () => {
  const run = runCrawler('duct-drop-utility', 300)

  it('the crawler reaches an obstruction and raises a suspicion', () => {
    const suspicions = run.candidates.filter((c) => c.detectorId === 'constrained.obstruction')
    expect(suspicions.length, 'the crawler never reached anything').toBeGreaterThan(0)
    expect(run.inchworms.get(INCHWORM.id)!.travelledM).toBeGreaterThan(5)
  })

  it('every suspicion becomes a handoff job at a port', () => {
    const handoffs = [...run.jobs.values()].filter((j) => j.job.handoffFrom !== undefined)
    expect(handoffs.length, 'a suspicion was never escalated').toBeGreaterThan(0)
    for (const h of handoffs) {
      expect(h.job.port, 'the escalation must be anchored to a port').toBeDefined()
      expect(h.job.manifold, 'the work happens on the ground manifold').toBe('ground')
      expect(h.job.requiredCapabilities).toContain('sense.thermal')
    }
  })

  it('the job is anchored at the port, not at the defect', () => {
    // The whole content of mechanism 1. A job at the defect would be unservable —
    // and would report a starved job rather than an architectural fact.
    const h = [...run.jobs.values()].find((j) => j.job.handoffFrom !== undefined)!
    const port = house.ports.find((p) => p.id === h.job.port)!
    const centre = { x: (h.job.region.minX + h.job.region.maxX) / 2, z: (h.job.region.minZ + h.job.region.maxZ) / 2 }
    expect(Math.hypot(centre.x - port.position[0], centre.z - port.position[2])).toBeLessThan(0.01)

    // And the defect is somewhere else entirely — meters away, inside the pipe.
    const suspect = run.candidates.find(
      (c) => c.detectorId === 'constrained.obstruction' && Math.abs(c.x - centre.x) > 1,
    )
    expect(suspect, 'the defect should not be at the port — that is the whole point').toBeDefined()
  })

  it('the crawler cannot bid on its own escalation', () => {
    // Capability handoff rather than distance handoff. If the crawler could service
    // its own suspicion the port graph would be decorative.
    const h = [...run.jobs.values()].find((j) => j.job.handoffFrom !== undefined)!
    const bids = h.bids.filter((b) => b.agentId === INCHWORM.id)
    for (const b of bids) {
      expect(b.eligible, 'the crawler must not be eligible for a thermal verification').toBe(false)
      expect(b.reasons.join(' ')).toMatch(/sense\.thermal|manifold/)
    }
  })

  it('a thermal-capable agent takes it', () => {
    const handoffs = [...run.jobs.values()].filter((j) => j.job.handoffFrom !== undefined)
    const worked = handoffs.filter((j) => j.awardedTo === GROUND_BOT.id)
    expect(worked.length, 'the escalation was never serviced by anyone').toBeGreaterThan(0)
    for (const j of worked) expect(j.job.state).toBe('done')
  })

  it('is decided exactly once per handoff', () => {
    // Without the guard, the tally counted one escalation per tick the job sat in
    // its bid window: 26 unconfirmations from 2 handoffs.
    const handoffs = [...run.jobs.values()].filter((j) => j.job.handoffFrom !== undefined)
    expect(run.handoffs.raised).toBe(handoffs.length)
    expect(run.handoffs.confirmed + run.handoffs.unconfirmed).toBe(run.handoffs.raised)
  })
})

describe('the confirmation rate, which is zero', () => {
  const run = runCrawler('duct-drop-utility', 300)

  it('is 0% on the authored content, and the run says so rather than hiding it', () => {
    expect(run.handoffs.raised).toBeGreaterThan(0)
    expect(run.handoffs.confirmed).toBe(0)
    expect(run.handoffs.unconfirmed).toBe(run.handoffs.raised)
  })

  it('every escalation was decided, so the rate is over decisions and not over time', () => {
    for (const j of run.jobs.values()) {
      if (j.job.handoffFrom === undefined) continue
      expect(j.confirmation, 'an undecided escalation would report a confident 0%').not.toBeUndefined()
    }
  })

  it('can confirm when the evidence is there — so the 0% is about the world, not the code', () => {
    // The test that makes the finding above trustworthy. If this failed, the 0%
    // would be a bug and the honest report would be "the mechanism does not work",
    // not "the mechanism works and cannot corroborate".
    const probe = steppedUntilHandoff()
    const h = [...probe.jobs.values()].find((j) => j.job.handoffFrom !== undefined)!
    if (h === undefined) throw new Error('no handoff appeared')
    const centre = { x: (h.job.region.minX + h.job.region.maxX) / 2, z: (h.job.region.minZ + h.job.region.maxZ) / 2 }

    // A thermal finding exactly at the port, raised before the escalation is
    // evaluated — the shape a real corroborating reading would have.
    probe.candidates.push({
      id: 'probe-thermal',
      detectorId: 'thermal.baseline',
      predictedClass: 'thermal_anomaly',
      agentId: GROUND_BOT.id,
      tick: 0,
      x: centre.x,
      y: 1.0,
      z: centre.z,
      halfExtents: [0.3, 0.3, 0.3],
      confidence: 0.8,
      magnitude: 6,
      manifold: 'ground',
      unverified: false,
    })
    // Clear the verdict and re-run the market, which is what reads the evidence.
    h.confirmation = undefined
    h.job.state = 'announced'
    stepMarket(probe)

    expect(h.confirmation, 'a thermal finding at the port must corroborate').toBe(true)
  })

  it('does not confirm on non-thermal evidence', () => {
    // Confirming a thermal suspicion with a geometric detection elsewhere in the room
    // is the kind of looseness that turns a 0% rate into a comfortable one.
    const probe = steppedUntilHandoff()
    const h = [...probe.jobs.values()].find((j) => j.job.handoffFrom !== undefined)!
    if (h === undefined) throw new Error('no handoff appeared')
    const centre = { x: (h.job.region.minX + h.job.region.maxX) / 2, z: (h.job.region.minZ + h.job.region.maxZ) / 2 }
    probe.candidates.push({
      id: 'probe-clutter',
      detectorId: 'geometry.clutter',
      predictedClass: 'clutter_hazard',
      agentId: GROUND_BOT.id,
      tick: 0,
      x: centre.x,
      y: 0.2,
      z: centre.z,
      halfExtents: [0.3, 0.3, 0.3],
      confidence: 0.9,
      magnitude: 3,
      manifold: 'ground',
      unverified: false,
    })
    h.confirmation = undefined
    h.job.state = 'announced'
    stepMarket(probe)

    expect(h.confirmation, 'clutter must not corroborate a blockage').toBe(false)
  })
})

describe('reachability still governs the constrained manifold', () => {
  it('a crawler in one component never sees another component’s defects', () => {
    const utility = runCrawler('duct-drop-utility', 300)
    const sink = runCrawler('sink-tail', 120)

    const arcsOf = (r: typeof utility) =>
      r.candidates.filter((c) => c.detectorId === 'constrained.obstruction').map((c) => `${c.x.toFixed(3)},${c.z.toFixed(3)}`).sort()

    // The void and the sink waste run are different components, so the two crawlers
    // must have found different things. If both found the same set, the manifold is
    // connected and spec 11.22's finding is wrong.
    expect(arcsOf(utility).join()).not.toBe(arcsOf(sink).join())
    expect(arcsOf(sink).length).toBeGreaterThan(0)
  })

  it('a suspicion in a component with no port is not escalated, and says why', () => {
    // Every authored conduit has a port, so this cannot fire on house-01. Asserted as
    // a property of the guard rather than left implicit, because the alternative is a
    // job with no possible bidder — a starved job, which reads like a swarm failure
    // rather than like an architectural fact.
    const sink = runCrawler('sink-tail', 120)
    const handoffs = [...sink.jobs.values()].filter((j) => j.job.handoffFrom !== undefined)
    for (const h of handoffs) expect(h.job.port).toBe('sink-tail')
  })
})

describe('the frame contract still holds with a crawler that has found something', () => {
  it('the crawler is still projected to a finite world position', () => {
    // Regression guard. The projection was added in Stage E and this is the first
    // run in which the crawler has actual candidates attached to it.
    const run = runCrawler('duct-drop-utility', 300)
    for (const a of run.agents) {
      if (isLumenPose(a.pose)) continue
      expect(Number.isFinite(a.pose.x)).toBe(true)
    }
    const crawler = run.agents.find((a) => a.spec.id === INCHWORM.id)!
    expect(Number.isFinite(crawler.battery)).toBe(true)
  })
})

describe('the ground baseline is untouched', () => {
  it('the reference run still hashes to the pinned value', () => {
    // Three authored in-bore defects went into the oracle for this stage, all with
    // `sourceStrength: 0` and all placed far from any ground vent port. This asserts
    // that authoring content on the constrained manifold did not move the ground
    // manifold's evidence — the property that makes the two independently authorable.
    const run = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, enableJobs: true }),
        spawn,
      ),
    )
    expect(run.log.hash()).toBe(BROWSER_PARITY_HASH)
    expect(run.jobTally.announced).toBe(40)
    expect(run.jobTally.done).toBe(31)
    expect(run.jobTally.failed).toBe(9)
    expect(run.candidates.filter((c) => c.detectorId === 'constrained.obstruction')).toEqual([])
  })
})