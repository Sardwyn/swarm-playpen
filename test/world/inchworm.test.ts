/**
 * Stage E — the constrained manifold: lumen graph, inchworm, graph-relational SLAM,
 * port traversal, and the irreversible-commitment case.
 *
 * The organising worry of this file is the project's recurring bug class: **a
 * subsystem that returns nothing looks exactly like a clean building.** Three of
 * the bugs found while building this stage were of that shape and none of them
 * would have failed a coverage assertion:
 *
 * 1. The crawler's landmark test re-fired every tick it sat beside a node. It
 *    reported 2638 loop closures over 25 m of travel and a drift rate of
 *    "0.085 m per 10 m" with three significant figures — a number that looked like
 *    a measurement and was pure numerical noise.
 * 2. The same bug stalled the crawler in a 1 m oscillation at a landmark, so
 *    coverage read 10.7% of a 28 m conduit and nothing looked wrong.
 * 3. Five new constrained<->ground ports made the blocked-vent detector fire at a
 *    pipe penetration one metre from a real blocked vent — a true positive reached
 *    for entirely the wrong reason, which is worse than a miss because it survives
 *    a precision check.
 *
 * So most of what follows is not "does it work" but "does it fail loudly".
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01, loadHouse } from '../../src/sim/world/content.ts'
import houseRaw from '../../src/content/house-01.json'
import {
  buildLumenGraph,
  boreClass,
  canEnter,
  clampArc,
  featureNear,
  isIrreversible,
  positionAt,
  routeInLumen,
} from '../../src/sim/world/lumen.ts'
import type { LumenGraph } from '../../src/sim/world/lumen.ts'
import { INCHWORM } from '../../src/sim/types.ts'
import { GROUND_BOT } from '../../src/sim/sim/agents.ts'
import {
  createInchwormState,
  driftRatePer10m,
  tickInchworm,
  worstCaseDriftBound,
  ODOMETRY_SCALE_ERROR,
  FEATURE_TOLERANCE,
} from '../../src/sim/sim/inchworm.ts'
import type { AgentState, Conduit } from '../../src/sim/types.ts'
import { EventLog } from '../../src/sim/eventlog.ts'
import { Rng } from '../../src/sim/rng.ts'
import { createRun, defaultConfig, runToCompletion } from '../../src/sim/sim/run.ts'
import { buildBid, auctionVerdict, rankBids } from '../../src/sim/jobs/market.ts'
import { conduitScanJob } from '../../src/sim/jobs/schema.ts'
import { loadAnomalies01 } from '../../src/sim/world/anomalies.ts'
import { buildReport } from '../../src/sim/report/report.ts'
import { frameFromRun } from '../../src/sim/report/frame.ts'

const house = loadHouse01()
const graph = buildLumenGraph(house.conduits)
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

// ---------------------------------------------------------------------------
// The lumen graph. Spec §2.2
// ---------------------------------------------------------------------------

describe('lumen graph — geometry', () => {
  it('has the six conduits of spec §2.2', () => {
    expect(house.conduits.map((c) => c.id).sort()).toEqual([
      'cavity-kitchen',
      'extract-bath',
      'extract-kitchen',
      'flue-boiler',
      'void-perimeter',
      'waste-sink',
    ])
  })

  it('parameterises arc length monotonically and finitely on every conduit', () => {
    for (const [id, geo] of graph.conduits) {
      for (let i = 1; i < geo.cumulative.length; i++) {
        expect(geo.cumulative[i]!, `${id} arc went backwards at ${i}`).toBeGreaterThan(geo.cumulative[i - 1]!)
      }
      expect(geo.total, `${id} has non-finite length`).toBeGreaterThan(0)
      expect(Number.isFinite(geo.total)).toBe(true)
    }
  })

  it('places arc 0 and arc total at the authored endpoints', () => {
    for (const [id, geo] of graph.conduits) {
      const first = geo.conduit.points[0]!
      const last = geo.conduit.points[geo.conduit.points.length - 1]!
      const at0 = positionAt(geo, 0)
      const atEnd = positionAt(geo, geo.total)
      for (let k = 0; k < 3; k++) {
        expect(at0[k]!, `${id} arc 0 axis ${k}`).toBeCloseTo(first[k]!, 6)
        expect(atEnd[k]!, `${id} arc total axis ${k}`).toBeCloseTo(last[k]!, 6)
      }
    }
  })

  it('classifies bore by the spec §3.2 limits, and a 40 mm run is small', () => {
    expect(boreClass(0.02)).toBe('small')
    expect(boreClass(0.08)).toBe('small')
    expect(boreClass(0.0801)).toBe('medium')
    expect(boreClass(0.25)).toBe('medium')
    expect(boreClass(0.3)).toBe('large')

    // The spec's named case, asserted by name rather than left implicit.
    const waste = graph.conduits.get('waste-sink')!
    expect(waste.class).toBe('small')
    expect(waste.conduit.bore).toBeLessThanOrEqual(0.04)
  })

  it('clamps arc outside the conduit instead of producing a position off the pipe', () => {
    for (const geo of graph.conduits.values()) {
      const over = positionAt(geo, geo.total + 100)
      const under = positionAt(geo, -100)
      expect(over.every(Number.isFinite)).toBe(true)
      expect(under.every(Number.isFinite)).toBe(true)
      expect(clampArc(geo, -5)).toBe(0)
      expect(clampArc(geo, geo.total + 5)).toBeCloseTo(geo.total, 9)
    }
  })

  it('finds a feature only within its tolerance band', () => {
    const flue = graph.conduits.get('flue-boiler')!
    expect(featureNear(flue, 1.5, 0.05)?.kind).toBe('elbow-1')
    // Just outside the band is not a sighting. This is the distinction the latch
    // depends on and the first version got wrong.
    expect(featureNear(flue, 1.5 + 0.4, 0.05)).toBeNull()
  })

  it('recognises exactly the two authored loops', () => {
    const loops = [...graph.conduits.values()].filter(
      (g) => g.conduit.startPort !== undefined && g.conduit.startPort === g.conduit.endPort,
    )
    expect(loops.map((g) => g.conduit.id).sort()).toEqual(['cavity-kitchen', 'void-perimeter'])
  })
})

// ---------------------------------------------------------------------------
// Capability. Spec §3.2
// ---------------------------------------------------------------------------

describe('lumen graph — who can go where', () => {
  it('the ground bot cannot enter any conduit, because it holds no crawl capability', () => {
    // The single most important capability assertion in the stage. If the ground
    // bot could enter a bore, the manifold split would be decoration and every
    // coverage number would be a claim about a robot that does not exist.
    expect(GROUND_BOT.capabilities).not.toContain('crawl.small')
    expect(GROUND_BOT.capabilities).not.toContain('crawl.medium')
    for (const geo of graph.conduits.values()) {
      expect(canEnter(geo, GROUND_BOT.capabilities), `${geo.conduit.id} should be closed to the ground bot`).toBe(
        false,
      )
    }
  })

  it('the inchworm can enter every authored conduit', () => {
    for (const geo of graph.conduits.values()) {
      expect(canEnter(geo, INCHWORM.capabilities), `${geo.conduit.id} should be enterable`).toBe(true)
    }
  })

  it('a small-bore-only agent is locked out of the 120 mm extract duct', () => {
    const duct = graph.conduits.get('extract-kitchen')!
    expect(duct.class).toBe('medium')
    expect(canEnter(duct, ['crawl.small'])).toBe(false)
    expect(canEnter(duct, ['crawl.medium'])).toBe(true)
  })

  it('marks the 40 mm run irreversible and the wider runs reversible', () => {
    // Spec §3.2: below 80 mm an agent that enters cannot turn around.
    expect(isIrreversible(graph.conduits.get('waste-sink')!)).toBe(true)
    expect(isIrreversible(graph.conduits.get('void-perimeter')!)).toBe(true)
    expect(isIrreversible(graph.conduits.get('extract-kitchen')!)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Routing. Spec §5.3
// ---------------------------------------------------------------------------

describe('lumen routing', () => {
  it('walks a conduit from the port the agent is standing at', () => {
    const r = routeInLumen(graph, { atPort: 'duct-drop-utility' }, { conduitId: 'void-perimeter', arc: 8 })
    expect(r.reachable).toBe(true)
    expect(r.length).toBeCloseTo(8, 6)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]!.conduitId).toBe('void-perimeter')
    expect(r.steps[0]!.toArc).toBeCloseTo(8, 9)
  })

  it('chains through a shared port between two conduits', () => {
    // flue-base -> flue-boiler -> vent-kitchen-wall -> extract-kitchen. Three
    // segments, and getting this wrong is how a crawler ends up in a duct it never
    // entered.
    const r = routeInLumen(graph, { atPort: 'flue-base' }, { conduitId: 'extract-kitchen', arc: 2 })
    expect(r.reachable).toBe(true)
    expect(r.steps.map((s) => s.conduitId)).toEqual(['flue-boiler', 'extract-kitchen'])
    expect(r.steps[0]!.fromArc).toBe(0)
    expect(r.steps[0]!.toArc).toBeCloseTo(r.steps[0]!.fromArc + graph.conduits.get('flue-boiler')!.total, 6)
    expect(r.steps[1]!.fromArc).toBeCloseTo(0, 6)
    expect(r.steps[1]!.toArc).toBeCloseTo(2, 6)
  })

  it('can traverse a conduit backwards', () => {
    const r = routeInLumen(graph, { atPort: 'extract-kitchen-end' }, { conduitId: 'flue-boiler', arc: 3.2 })
    expect(r.reachable).toBe(true)
    expect(r.steps[0]!.conduitId).toBe('extract-kitchen')
    // Entering from the far end means walking toward arc 0.
    expect(r.steps[0]!.fromArc).toBeGreaterThan(r.steps[0]!.toArc)
  })

  it('reports unreachable rather than inventing a route', () => {
    // The constrained manifold is NOT connected. Every conduit component is its own
    // island, because the only links are ports and no two of these ports touch the
    // same conduit. A router that returned a route here would be the whole
    // confinement problem quietly discarded.
    const r = routeInLumen(graph, { atPort: 'duct-drop-utility' }, { conduitId: 'waste-sink', arc: 1 })
    expect(r.reachable).toBe(false)
    expect(r.blockedReason).toMatch(/no port path/)
    expect(r.steps).toHaveLength(0)
  })

  it('does not route through a loop to get somewhere — a loop is not a shortcut', () => {
    // void-perimeter has the same port at both ends, so it is a self-edge in the
    // port graph and contributes nothing to a shortest path. Correct: the only
    // benefit of a loop is to be crawled, and that is the agent's arc motion, not
    // the router's business.
    const r = routeInLumen(graph, { atPort: 'duct-drop-utility' }, { conduitId: 'void-perimeter', arc: 2 })
    expect(r.reachable).toBe(true)
    expect(r.length).toBeCloseTo(2, 6)
  })

  it('is deterministic regardless of which end of the loop the agent starts at', () => {
    const forward = routeInLumen(graph, { atPort: 'flue-base' }, { conduitId: 'extract-kitchen', arc: 1 })
    const reverse = routeInLumen(graph, { atPort: 'extract-kitchen-end' }, { conduitId: 'flue-boiler', arc: 1 })
    expect(forward.reachable).toBe(true)
    expect(reverse.reachable).toBe(true)
    // Both must terminate the last leg at the requested arc, or the agent arrives
    // at the wrong end of the pipe.
    expect(forward.steps[forward.steps.length - 1]!.toArc).toBeCloseTo(1, 9)
    expect(reverse.steps[reverse.steps.length - 1]!.toArc).toBeCloseTo(1, 9)
  })
})

// ---------------------------------------------------------------------------
// Content validation. The bugs this catches are all "looks fine, silently wrong".
// ---------------------------------------------------------------------------

describe('content validation — conduits', () => {
  const base = (over: Partial<Conduit>): Conduit => ({
    id: 'test-conduit',
    name: 'Test',
    bore: 0.05,
    points: [
      [0, 0, 0],
      [1, 0, 0],
    ],
    features: [],
    ...over,
  })

  const wrap = (conduits: unknown[], ports?: unknown[]): unknown => ({
    id: 'h',
    name: 'h',
    bounds: { minX: -5, minY: 0, minZ: -5, maxX: 5, maxY: 3, maxZ: 5 },
    rooms: [],
    obstacles: [],
    ports: ports ?? [{ id: 'p1', a: 'constrained', b: 'ground', position: [0, 0, 0], radius: 0.05, kind: 'conduit_entry' }],
    conduits,
    spawn: { x: 0, z: 0, theta: 0 },
  })

  it('rejects a centreline with fewer than two points', () => {
    expect(() => loadHouse(wrap([base({ points: [[0, 0, 0]] })]))).toThrow(/at least two points/)
  })

  it('rejects a non-finite centreline point', () => {
    // A NaN coordinate makes every arc comparison false, so the agent stands still
    // for the whole mission and reports itself healthy.
    expect(() =>
      loadHouse(wrap([base({ points: [[0, 0, 0], [Number.NaN, 1, 0]] })])),
    ).toThrow(/three finite numbers/)
  })

  it('rejects two identical consecutive points, which give a zero-length segment', () => {
    expect(() =>
      loadHouse(
        wrap([
          base({
            points: [
              [0, 0, 0],
              [0, 0, 0],
            ],
          }),
        ]),
      ),
    ).toThrow(/identical/)
  })

  it('rejects a feature outside the conduit, which could never be reached', () => {
    // This is the one that presents as a localisation result: a landmark past the
    // end can never fire, so "loop closure never triggers" looks like drift being
    // unbounded when it is a typo in a number.
    expect(() => loadHouse(wrap([base({ features: [{ arc: 99, kind: 'tee' }] })]))).toThrow(/could never be reached/)
  })

  it('rejects a conduit referencing a port that does not exist', () => {
    expect(() => loadHouse(wrap([base({ startPort: 'nope' })]))).toThrow(/unknown port 'nope'/)
  })

  it('rejects a loop that does not close in the geometry', () => {
    // Same port at both ends but the polyline wanders off: the agent crawls the
    // perimeter and the exit it was promised is not there.
    expect(() =>
      loadHouse(
        wrap(
          [
            base({
              startPort: 'p1',
              endPort: 'p1',
              points: [
                [0, 0, 0],
                [3, 0, 0],
              ],
            }),
          ],
          [{ id: 'p1', a: 'constrained', b: 'ground', position: [0, 0, 0], radius: 0.05, kind: 'conduit_entry' }],
        ),
      ),
    ).toThrow(/does not close/)
  })

  it('rejects a conduit_entry port with no constrained side', () => {
    // The declared purpose is the only thing that keeps the blocked-vent detector
    // off a penetration, so a contradiction here would silently disable it.
    expect(() =>
      loadHouse(
        wrap([base({ startPort: 'p1' })], [
          { id: 'p1', a: 'ground', b: 'ground', position: [0, 0, 0], radius: 0.05, kind: 'conduit_entry' },
        ]),
      ),
    ).toThrow(/conduit_entry/)
  })

  it('rejects an unknown port kind rather than trusting it', () => {
    expect(() =>
      loadHouse(
        wrap([base({ startPort: 'p1' })], [
          { id: 'p1', a: 'constrained', b: 'ground', position: [0, 0, 0], radius: 0.05, kind: 'airway' },
        ]),
      ),
    ).toThrow(/unknown port kind/)
  })

  it('accepts a house with no conduits at all', () => {
    // Stage A–D fixtures have no pipes, and requiring the field would put Stage E
    // geometry into every earlier test bed.
    const h = loadHouse(wrap([]))
    expect(h.conduits).toEqual([])
    expect(buildLumenGraph(h.conduits).conduits.size).toBe(0)
  })

  it('rejects duplicate conduit ids, which would drop one on lookup', () => {
    expect(() =>
      loadHouse(
        wrap([
          base({ id: 'dup' }),
          base({
            id: 'dup',
            points: [
              [0, 0, 1],
              [1, 0, 1],
            ],
          }),
        ]),
      ),
    ).toThrow(/duplicate conduit id/)
  })
})

// ---------------------------------------------------------------------------
// Ports: the bug the parity pin caught.
// ---------------------------------------------------------------------------

describe('port kinds — a penetration is not a ventilation register', () => {
  it('the five conduit endpoints are declared conduit_entry, not vents', () => {
    for (const id of ['sink-tail', 'cavity-entry', 'flue-base', 'extract-kitchen-end', 'extract-bath-end']) {
      const port = house.ports.find((p) => p.id === id)
      expect(port, `${id} missing`).toBeDefined()
      expect(port!.kind, `${id} must not be a vent`).toBe('conduit_entry')
    }
  })

  it('the blocked-vent detector does not fire on a conduit penetration', () => {
    // Regression guard for the parity-pin movement. Stage E added five ports, and
    // inferring "this is an air register" from "one side is ground" made the
    // detector fire at the boiler flue — a true positive one metre from the real
    // blocked vent, reached for entirely the wrong reason.
    //
    // Filtered on `detectorId` from the candidate list rather than on the event log,
    // because the log carries no detector identity — a gap worth naming but not worth
    // widening the event schema for here.
    const withCrawler = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, agents: [GROUND_BOT, INCHWORM] }),
        spawn,
      ),
    )
    const penetrations = ['sink-tail', 'cavity-entry', 'flue-base', 'extract-kitchen-end', 'extract-bath-end']
    const atPipe = withCrawler.candidates.filter(
      (c) =>
        c.detectorId === 'geometry.blocked_vent' &&
        penetrations.some((id) => {
          const p = house.ports.find((q) => q.id === id)!
          return Math.hypot(p.position[0] - c.x, p.position[2] - c.z) < 0.4
        }),
    )
    expect(
      atPipe.map((c) => `${c.id} at ${c.x.toFixed(2)},${c.z.toFixed(2)}`),
      'a blocked-vent candidate was raised at a pipe penetration',
    ).toEqual([])
  })

  it('the real blocked vent is still found', () => {
    // The other half. Suppressing the false positive by disabling the detector would
    // pass the test above and break this one. Both have to hold.
    const r = runToCompletion(
      createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300 }), spawn),
    )
    const vents = r.candidates.filter((c) => c.detectorId === 'geometry.blocked_vent')
    expect(vents.length, 'the blocked-vent detector is now silent').toBeGreaterThan(0)
  })

  it('a crawler contributes nothing to the ground-manifold findings', () => {
    // The constrained manifold must not be able to inject ground-manifold findings.
    //
    // Note this is *not* "the run is unchanged": adding a second agent changes the
    // coverage-job budget, which changes the ground bot's path, which legitimately
    // changes what it sees. The claim is the narrower and more important one — every
    // finding on the ground manifold came from the ground bot.
    //
    // Restated at Stage E part three, when the crawler started raising findings of its
    // own. Those are constrained-manifold and carry the crawler as their agent; the
    // previous version of this test asserted the crawler produced *nothing at all*,
    // which was true only while it had no instrument.
    const pair = runToCompletion(
      createRun(
        house,
        defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300, agents: [GROUND_BOT, INCHWORM] }),
        spawn,
      ),
    )
    for (const c of pair.candidates) {
      if (c.manifold === 'ground') {
        expect(c.agentId, `a ground finding attributed to ${c.agentId}`).toBe(GROUND_BOT.id)
      } else {
        expect(c.manifold, 'the crawler may only speak for the constrained manifold').toBe('constrained')
        expect(c.agentId).toBe(INCHWORM.id)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The crawler itself.
// ---------------------------------------------------------------------------

function freshAgent(spec = INCHWORM): AgentState {
  return {
    spec,
    stalledTicks: 0,
    pose: { conduitId: '', arc: 0, offset: 0, roll: 0 },
    manifold: 'constrained',
    battery: 1,
    energyUsed: 0,
    calibration: 'uncalibrated',
    ticksSinceCalibration: 0,
    calibrating: false,
    faulted: false,
    plan: [],
    planIndex: 0,
    plan3: [],
    plan3Index: 0,
    tilt: 0,
    goal: null,
    currentJobId: null,
    tickPathLength: 0,
  }
}

/**
 * Drive a crawler directly, without the market.
 *
 * `stopOnArrival` defaults to true because most of what is being tested is "does it
 * get there and stop". The loop-closure tests need it false: an agent that stops on
 * arriving never laps a loop, so closure could not be observed at all — which is
 * also true in the live run, because the crawler idles once coverage saturates and
 * has no reason to re-traverse. Loop closure needs a directed traversal.
 */
function crawl(
  graphFor: LumenGraph,
  target: { conduitId: string; arc: number },
  maxTicks: number,
  homePort = 'cavity-entry',
  stopOnArrival = true,
): { inch: ReturnType<typeof createInchwormState>; state: AgentState; log: EventLog } {
  const inch = createInchwormState()
  const log = new EventLog()
  const ctx = {
    graph: graphFor,
    rng: new Rng(1),
    log,
    tick: 0,
    noiseMultiplier: 0,
    job: target,
    homePort,
  }
  let state = freshAgent()
  for (let t = 0; t < maxTicks; t++) {
    ctx.tick = t
    const r = tickInchworm(state, inch, ctx)
    state = r.state
    if (stopOnArrival && r.arrived) break
  }
  return { inch, state, log }
}

/** The documented arrival tolerance. Asserting tighter than this tests nothing. */
const ARRIVAL_TOLERANCE = 0.12

/**
 * Drive a crawler through a *sequence* of targets.
 *
 * A lap cannot be produced by pointing the crawler at one arc: the moment it is
 * within tolerance of the target it stops, because that is what arriving means, and
 * no flag on the loop changes that. A real crawl of a closed loop is a survey —
 * out to one end, back past the middle, out again — and revisiting landmarks is
 * exactly what that produces. So the SLAM tests drive a survey, which is the
 * behaviour under test rather than a contrivance to get past the arrival check.
 */
function crawlSequence(
  graphFor: LumenGraph,
  targets: readonly { conduitId: string; arc: number }[],
  ticksPerLeg: number,
  homePort: string,
): { inch: ReturnType<typeof createInchwormState>; state: AgentState; log: EventLog } {
  const inch = createInchwormState()
  const log = new EventLog()
  let state = freshAgent()

  for (const target of targets) {
    const ctx = {
      graph: graphFor,
      rng: new Rng(1),
      log,
      tick: 0,
      noiseMultiplier: 0,
      job: target,
      homePort,
    }
    for (let t = 0; t < ticksPerLeg; t++) {
      const r = tickInchworm(state, inch, ctx)
      state = r.state
      if (r.arrived) break
    }
  }
  return { inch, state, log }
}

describe('inchworm — locomotion', () => {
  it('enters a conduit from its port and reaches the target arc', () => {
    const { inch } = crawl(graph, { conduitId: 'waste-sink', arc: 1.8 }, 2000, 'sink-tail')
    expect(inch.pose).not.toBeNull()
    expect(inch.pose!.conduitId).toBe('waste-sink')
    expect(inch.pose!.arc).toBeCloseTo(1.8, ARRIVAL_TOLERANCE)
  })

  it('stops within the arrival tolerance rather than overshooting', () => {
    // The crawler halts as soon as it is within tolerance, so its final arc is
    // short of the target by up to that tolerance. Asserting exact arrival would be
    // asserting that the tolerance does not exist.
    const { inch } = crawl(graph, { conduitId: 'waste-sink', arc: 0.2 }, 2000, 'sink-tail')
    expect(inch.pose!.arc).toBeCloseTo(0.2, ARRIVAL_TOLERANCE)
    expect(inch.pose!.arc).toBeLessThan(0.35)
  })

  it('its believed position runs ahead of the true distance, and only by the scale error', () => {
    // Guards the oscillation bug in both directions. A crawler pinned at a landmark
    // accumulates true distance every tick while its believed position does not
    // move, which is the signature that broke the first version.
    const { inch } = crawl(graph, { conduitId: 'waste-sink', arc: 1.8 }, 2000, 'sink-tail')
    const over = Math.abs(inch.pose!.arc) - inch.travelledM
    expect(over, 'the drive train over-reports, so believed > true').toBeGreaterThan(0)
    // And by no more than the declared scale error, allowing for the crawl
    // finishing part-way into a tick.
    expect(over).toBeLessThan(inch.travelledM * ODOMETRY_SCALE_ERROR + 0.02)
  })

  it('spends energy, and idling is cheaper than crawling', () => {
    const moving = crawl(graph, { conduitId: 'waste-sink', arc: 1.8 }, 400, 'sink-tail')
    expect(moving.state.energyUsed).toBeGreaterThan(0)
    expect(moving.state.battery).toBeLessThan(1)

    // Idle: same duration, no job, so no crawl.
    const inch = createInchwormState()
    const log = new EventLog()
    let state = freshAgent()
    for (let t = 0; t < 400; t++) {
      state = tickInchworm(state, inch, {
        graph,
        rng: new Rng(1),
        log,
        tick: t,
        noiseMultiplier: 0,
        job: null,
        homePort: 'sink-tail',
      }).state
    }
    expect(state.energyUsed).toBeGreaterThan(0)
    expect(state.energyUsed).toBeLessThan(moving.state.energyUsed)
    expect(inch.pose).toBeNull()
  })

  it('is deterministic for the same seed and target', () => {
    const a = crawl(graph, { conduitId: 'cavity-kitchen', arc: 6 }, 1500)
    const b = crawl(graph, { conduitId: 'cavity-kitchen', arc: 6 }, 1500)
    expect(a.inch.travelledM).toBe(b.inch.travelledM)
    expect(a.inch.pose!.arc).toBe(b.inch.pose!.arc)
    expect(a.log.hash()).toBe(b.log.hash())
  })

  it('cannot be given a job in a conduit it cannot reach, and says so', () => {
    // No port path from the cavity to the waste run. A silent no-op here would look
    // exactly like a crawler that has surveyed everything.
    const inch = createInchwormState()
    const log = new EventLog()
    const state = tickInchworm(freshAgent(), inch, {
      graph,
      rng: new Rng(1),
      log,
      tick: 5,
      noiseMultiplier: 0,
      job: { conduitId: 'waste-sink', arc: 1 },
      homePort: 'cavity-entry',
    })
    expect(state.moved).toBe(0)
    expect(log.byKind('job.failed').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Graph-relational SLAM. Spec §5.3
// ---------------------------------------------------------------------------

describe('graph-relational SLAM', () => {
  // A survey of the 8 m wall cavity, out and back twice. The single landmark sits at
  // arc 1.6, so every pass re-enters its band — which is what makes the closure
  // observable. Note this cannot happen through the job system: once coverage
  // saturates there is nothing left to announce, so the crawler idles and never
  // revisits anything.
  const cavity = () => graph.conduits.get('cavity-kitchen')!
  const survey = () =>
    crawlSequence(
      graph,
      [
        { conduitId: 'cavity-kitchen', arc: 7.5 },
        { conduitId: 'cavity-kitchen', arc: 0.4 },
        { conduitId: 'cavity-kitchen', arc: 7.5 },
        { conduitId: 'cavity-kitchen', arc: 0.4 },
      ],
      3000,
      'cavity-entry',
    )

  it('records each landmark once per visit, not once per tick', () => {
    // The bug this guards: 2638 "closures" over 25 m. A landmark must be *entered*,
    // and the agent must leave its band before it can be counted again.
    const { inch } = survey()
    expect(inch.seenFeatures.size, 'the cavity has one landmark').toBe(1)
    expect(inch.closures, 'two passes back and forth must re-enter the landmark').toBeGreaterThan(0)

    // The real invariant. Four legs over an 8 m loop is bounded in how many times the
    // landmark can be entered; the latch is what keeps the count small rather than
    // tracking the tick count.
    const legs = 4
    expect(inch.travelledM).toBeLessThan(legs * (cavity().total + 1))
    expect(inch.closures).toBeLessThanOrEqual(legs)
  })

  it('closes a loop on the return pass', () => {
    const { inch, log } = survey()
    expect(inch.travelledM, 'the crawler must have covered the loop more than once').toBeGreaterThan(cavity().total)
    expect(inch.closures, 'the return pass must produce a closure').toBeGreaterThan(0)
    expect(log.byKind('agent.loop_closed').length).toBeGreaterThan(0)
  })

  it('bounds the drift by landmark spacing rather than letting it grow', () => {
    // The claim of spec §5.3, stated as an inequality. On a one-dimensional manifold
    // a revisited landmark fixes the coordinate completely, so the error between
    // fixes is bounded by the distance between them — not by how far the agent has
    // crawled. That *boundedness* is the whole content of the claim.
    const { inch } = survey()
    const bound = worstCaseDriftBound(graph, 'cavity-kitchen')
    expect(bound).not.toBeNull()

    const drift = driftRatePer10m(inch)
    expect(drift, 'a closure happened, so drift must be measurable').not.toBeNull()

    // Every observed correction stays within the largest gap between fixes. This is
    // the boundedness claim, and it is what stops drift growing without limit.
    for (const s of inch.driftSamples) {
      expect(s.error).toBeLessThanOrEqual(bound! + 1e-6)
    }

    // And the observed rate is the drive train's error plus at most the landmark
    // detection band — not something that grows with distance. The band is included
    // because a landmark fires on proximity, not on exactness, and at 0.8% scale
    // error over an 8 m leg the band is a third of the signal.
    const uncorrectedPer10m = ODOMETRY_SCALE_ERROR * 10
    expect(drift!).toBeLessThanOrEqual(uncorrectedPer10m + (FEATURE_TOLERANCE * 10) / cavity().total)
  })

  it('the error it corrects at a landmark is the size of the error that accumulated', () => {
    // A closure is only meaningful if the correction is proportional to the drift
    // since the last fix, over the distance crawled to accumulate it.
    const { inch } = survey()
    expect(inch.driftSamples.length).toBeGreaterThan(0)
    for (const s of inch.driftSamples) {
      expect(s.error).toBeGreaterThan(0)
      expect(s.legMetres, 'a closure must record how far it crawled to get here').toBeGreaterThan(0)
      expect(s.error).toBeLessThan(cavity().total)
      // Bounded by the drive train's error over that leg, plus the detection band.
      // If a landmark corrects more than that, something other than scale error is
      // moving the belief.
      expect(s.error).toBeLessThanOrEqual(s.legMetres * ODOMETRY_SCALE_ERROR + FEATURE_TOLERANCE + 1e-6)
    }
  })

  it('would misplace itself by more than its own arrival tolerance if landmarks did not correct it', () => {
    // The counterfactual that makes the boundedness claim mean something. This is
    // the operational cost of drift: the agent believes it is at arc A, the market
    // decides whether it arrived from arc B, and if the gap exceeds the arrival
    // tolerance it fails jobs it physically reached. At 0.8% that happens after
    // 15 m — well inside one circuit of a normal under-floor loop.
    const { inch } = survey()
    const uncorrected = inch.travelledM * ODOMETRY_SCALE_ERROR
    expect(
      uncorrected,
      'the crawl must be long enough for uncorrected drift to exceed the arrival tolerance',
    ).toBeGreaterThan(ARRIVAL_TOLERANCE)

    // Every correction that actually arrived was smaller than that, because each one
    // landed before the belief could wander that far.
    for (const s of inch.driftSamples) {
      expect(s.error).toBeLessThan(uncorrected)
    }
  })

  it('reports null drift when nothing has been corrected, not zero', () => {
    // A run that never revisited a landmark has no drift measurement. Zero would
    // read as "drift was measured and found negligible", which is the claim this
    // project has been burned by repeatedly.
    const { inch } = crawl(graph, { conduitId: 'waste-sink', arc: 1.9 }, 2000, 'sink-tail')
    expect(driftRatePer10m(inch)).toBeNull()
  })

  it('the landmark spacing is a real bound on a real conduit', () => {
    const voidGeo = graph.conduits.get('void-perimeter')!
    const bound = worstCaseDriftBound(graph, 'void-perimeter')
    expect(bound).toBeGreaterThan(0)
    // A bound must be smaller than the thing it bounds, or "bounded by spacing" is
    // vacuous — and 5.4 m of allowed error on a 28 m loop is worth noticing.
    expect(bound!).toBeLessThan(voidGeo.total)
  })

  it('a loop closure is not an anomaly candidate', () => {
    // Filing SLAM bookkeeping as findings would have the per-class metric report
    // the localisation system as if it were the inspection system's output.
    const { log } = survey()
    expect(log.byKind('anomaly.candidate')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The irreversible commitment. Spec §3.2, §6.3
// ---------------------------------------------------------------------------

describe('the 40 mm commitment', () => {
  function bidForWasteRun() {
    const run = createRun(
      house,
      defaultConfig({ agents: [GROUND_BOT, INCHWORM], inchwormHomePort: 'sink-tail' }),
      spawn,
    )
    const record = conduitScanJob(
      {
        conduitId: 'waste-sink',
        arc: 1.5,
        position: [3.4, 0.4, -3.0],
      },
      'small',
      0,
    )
    const agent = run.agents.find((a) => a.spec.id === INCHWORM.id)!
    // The crawler is homed at the sink tail, and `measureDistance` bids 0 for an
    // unreachable job rather than an optimistic guess. Seeding the position is
    // therefore necessary to see the score at all — which is itself worth stating,
    // because the alternative (an unreachable job scoring 5.7) is how a contract net
    // rots.
    run.lumenPositions.set(INCHWORM.id, { atPort: 'sink-tail' })
    const bid = buildBid(
      {
        grid: run.grid,
        mask: run.mask,
        tick: 0,
        jobs: run.jobs,
        load: run.load, missionSeconds: run.config.missionSeconds,
        lumen: run.lumen,
        lumenPositions: run.lumenPositions,
      },
      agent,
      record,
    )
    return { bid, agent, record, run }
  }

  it('bids zero for a job it cannot reach, rather than an optimistic guess', () => {
    const run = createRun(house, defaultConfig({ agents: [GROUND_BOT, INCHWORM] }), spawn)
    const record = conduitScanJob(
      { conduitId: 'waste-sink', arc: 1, position: [4.6, 0.5, -2.6] },
      'small',
      0,
    )
    const agent = run.agents.find((a) => a.spec.id === INCHWORM.id)!
    // No recorded position, so the crawler is assumed to be at `duct-drop-utility`,
    // which cannot reach the kitchen sink. Unreachable, so it bids short.
    const bid = buildBid(
      {
        grid: run.grid,
        mask: run.mask,
        tick: 0,
        jobs: run.jobs,
        load: run.load, missionSeconds: run.config.missionSeconds,
        lumen: run.lumen,
        lumenPositions: new Map(),
      },
      agent,
      record,
    )
    // It then fails the arrival test and the job starves, which the allocator
    // escalates. That is the honest outcome; an optimistic guess is how a contract
    // net rots.
    expect(bid.distance).toBe(0)
  })

  it('the auction charges a crawler full irreversible risk for the 40 mm run', () => {
    const { bid } = bidForWasteRun()
    expect(bid.eligible).toBe(true)
    expect(bid.irreversibleRisk).toBe(1)
  })
  it('an irreversible commitment vetoes outright, rather than costing score', () => {
    // Rewritten after the kill condition removed the weighted score.
    //
    // This used to assert the penalty "depressed the score below the attraction
    // ceiling" � a property of a -2.0 weight that could in fact be outbid by a
    // nearby enough job, because the positive terms summed to 5.7. As a *rule* the
    // veto cannot be outbid at any distance, which is a strictly stronger property
    // and the one worth asserting.
    const { bid } = bidForWasteRun()
    expect(bid.eligible).toBe(true)
    expect(bid.irreversibleRisk).toBe(1)

    const rival = {
      agentId: 'ground-01',
      distance: 99,
      batteryHeadroom: 1,
      irreversibleRisk: 0,
      eligible: true,
      reasons: [],
    }
    expect(rankBids([bid, rival])[0]!.agentId).toBe(rival.agentId)
  })

  it('and carries no risk at all for a reversible conduit', () => {
    const run = createRun(house, defaultConfig({ agents: [GROUND_BOT, INCHWORM] }), spawn)
    const agent = run.agents.find((a) => a.spec.id === INCHWORM.id)!
    const record = conduitScanJob(
      { conduitId: 'extract-kitchen', arc: 1.5, position: [3.9, 2.25, -2.2] },
      'medium',
      0,
    )
    run.lumenPositions.set(INCHWORM.id, { atPort: 'vent-kitchen-wall' })
    const bid = buildBid(
      {
        grid: run.grid,
        mask: run.mask,
        tick: 0,
        jobs: run.jobs,
        load: run.load,
        missionSeconds: run.config.missionSeconds,
        lumen: run.lumen,
        lumenPositions: run.lumenPositions,
      },
      agent,
      record,
    )
    expect(bid.eligible).toBe(true)
    expect(bid.distance, 'the crawler must actually be able to get there').toBeGreaterThan(0)
    expect(bid.irreversibleRisk).toBe(0)
  })

})
// ---------------------------------------------------------------------------
// The swarm. Stage E's actual question.
// ---------------------------------------------------------------------------

describe('swarm with two agents', () => {
  const runPair = (missionSeconds = 300, homePort = 'duct-drop-utility') =>
    runToCompletion(
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

  it('the crawler surveys the constrained manifold rather than standing still', () => {
    const r = runPair()
    const inch = r.inchworms.get(INCHWORM.id)!
    const seen = [...r.conduitCoverage.get('void-perimeter')!].filter((c) => c > 0).length
    const total = r.conduitCoverage.get('void-perimeter')!.length
    expect(inch.travelledM, 'the crawler never moved').toBeGreaterThan(5)
    expect(seen / total, 'the crawler moved but surveyed almost nothing').toBeGreaterThan(0.5)
  })

  it('completes conduit jobs end to end', () => {
    const r = runPair()
    const constrained = [...r.jobs.values()].filter((j) => j.job.manifold === 'constrained')
    expect(constrained.length, 'no conduit work was ever announced').toBeGreaterThan(0)
    const done = constrained.filter((j) => j.job.state === 'done')
    expect(done.length, 'conduit jobs were announced but never completed').toBeGreaterThan(0)
  })

  it('every conduit job reaches a terminal state, so no work vanishes', () => {
    for (const homePort of ['duct-drop-utility', 'sink-tail', 'cavity-entry']) {
      const r = runPair(200, homePort)
      const stragglers = [...r.jobs.values()]
        .filter((j) => j.job.manifold === 'constrained')
        .filter((j) => j.job.state !== 'done' && j.job.state !== 'failed')
      expect(stragglers.map((j) => `${j.job.id}:${j.job.state}`), `home ${homePort}`).toEqual([])
    }
  })

  it('surveys only what it can reach, and does not starve on the rest', () => {
    // The constrained manifold is four disconnected components. A crawler homed in
    // the utility room cannot survey the kitchen sink at all, and a coordinator that
    // kept announcing sink jobs would post a perfect completion rate for the work it
    // could do and a silent zero for everything else.
    const utility = runPair(300, 'duct-drop-utility')
    expect(utility.conduitCoverage.get('waste-sink')!.every((c) => c === 0)).toBe(true)

    const sink = runPair(300, 'sink-tail')
    expect([...sink.conduitCoverage.get('waste-sink')!].filter((c) => c > 0).length).toBeGreaterThan(10)
  })

  it('coverage is a contiguous record of where the crawler has physically been', () => {
    // A ray-cast coverage rule would mark a whole conduit seen from its mouth. The
    // crawler must have been there, so coverage is contiguous from the entry and its
    // extent is bounded by how far it crawled.
    const r = runPair(300, 'sink-tail')
    const waste = r.conduitCoverage.get('waste-sink')!
    const covered = waste.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0)
    expect(covered.length).toBeGreaterThan(10)

    // Contiguous: no gaps, because the crawler cannot teleport inside a pipe.
    expect(covered[covered.length - 1]! - covered[0]! + 1).toBe(covered.length)

    // And it starts at the entry it came in through.
    expect(covered[0]).toBeLessThan(3)
  })

  it('a conduit the crawler never entered has no coverage at all', () => {
    // The negative control. Zero coverage in an unreachable conduit is the only
    // honest reading; anything else is the crawler claiming to have seen a pipe it
    // has no route to.
    const r = runPair(300, 'sink-tail')
    for (const id of ['flue-boiler', 'extract-kitchen', 'extract-bath', 'void-perimeter', 'cavity-kitchen']) {
      expect(
        r.conduitCoverage.get(id)!.every((c) => c === 0),
        `${id} shows coverage the crawler never made`,
      ).toBe(true)
    }
  })

  it('regret stays unevaluable, because the two agents never bid against each other', () => {
    // The finding of Stage E, and the reason `auctionVerdict` exists. Two agents
    // read like competition, but they are on different manifolds: the ground bot
    // cannot enter a bore and the crawler cannot drive. Mean regret is 0.00% over
    // dozens of awards and not one of them is contested, so the number measures the
    // absence of competition rather than the quality of the allocator.
    const r = runPair()
    expect(r.contestedAwards).toBe(0)
    const verdict = auctionVerdict({ mean: 0 }, r.contestedAwards)
    expect(verdict.status).toBe('not_evaluable')
  })

  it('improves the ground bot completion rate, by taking work off it', () => {
    // Worth stating explicitly, because "the swarm did better" and "the swarm
    // allocated better" are different claims and only the first is supported.
    const solo = runToCompletion(
      createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 300 }), spawn),
    )
    const pair = runPair()
    expect(pair.jobTally.done ?? 0).toBeGreaterThan(solo.jobTally.done ?? 0)
  })

  it('keeps the ground bot coverage complete', () => {
    const r = runPair()
    let total = 0
    let observed = 0
    for (let i = 0; i < r.mask.length; i++) {
      if (r.mask[i] !== 1) continue
      total++
      if (r.grid.observedCount[i]! >= 2) observed++
    }
    expect(total === 0 ? 0 : observed / total).toBeGreaterThan(0.999)
  })
})

// ---------------------------------------------------------------------------
// The frame contract. Spec 8.3 - the viewer's only route into the sim.
// ---------------------------------------------------------------------------

describe('the viewer can actually see the crawler', () => {
  it('projects a lumen pose to a finite world position', () => {
    // A crawler whose pose was cast to `{x, z}` yields `undefined`, which becomes
    // `NaN` in the vertex buffer, and the agent silently vanishes from the scene —
    // indistinguishable from a crawler that has not started yet.
    const r = runToCompletion(
      createRun(
        house,
        defaultConfig({
          seed: 1,
          noiseMultiplier: 0,
          missionSeconds: 200,
          agents: [GROUND_BOT, INCHWORM],
          inchwormHomePort: 'sink-tail',
        }),
        spawn,
      ),
    )
    const report = buildReport({
      runId: 'test',
      tick: r.tick,
      simSeconds: r.tick / 10,
      candidates: r.candidates,
      truth: r.truth,
      rooms: house.rooms,
      coverage: [],
      regionCoverage: [],
    })

    const frame = frameFromRun(r, report)
    expect(frame.agents.length).toBe(2)
    for (const a of frame.agents) {
      expect(Number.isFinite(a.x), `${a.id} x is not finite`).toBe(true)
      expect(Number.isFinite(a.y), `${a.id} y is not finite`).toBe(true)
      expect(Number.isFinite(a.z), `${a.id} z is not finite`).toBe(true)
      expect(Number.isFinite(a.heading), `${a.id} heading is not finite`).toBe(true)
    }

    const crawler = frame.agents.find((a) => a.cls === 'inchworm')!
    expect(crawler).toBeDefined()
    // Inside the house, not at the origin. A crawler parked at (0,0,0) is a
    // projection that failed silently.
    expect(Math.abs(crawler.x)).toBeLessThan(6)
    expect(Math.abs(crawler.z)).toBeLessThan(6)
  })
})

// ---------------------------------------------------------------------------
// Trust: the oracle must not have leaked into the constrained manifold.
// ---------------------------------------------------------------------------

describe('the constrained manifold does not read the answer key', () => {
  it('conduit jobs are still announced when the oracle is empty', () => {
    // The decisive test of "spawned from history, not from the answer key". Strip the
    // defects out entirely: a coordinator reading the oracle would announce nothing
    // and its coverage would read as a clean building. Ours announces survey work
    // anyway, because unsurveyed bore is a fact about the swarm's own history.
    const bare = loadHouse(houseRaw as unknown)

    const run = createRun(
      bare,
      defaultConfig({
        seed: 1,
        noiseMultiplier: 0,
        missionSeconds: 120,
        agents: [GROUND_BOT, INCHWORM],
        inchwormHomePort: 'sink-tail',
      }),
      spawn,
    )
    // `AnomalySet.anomalies` is readonly, which is the right constraint — so the
    // empty oracle is a different set rather than a mutated one. Built by replacing
    // the run's oracle wholesale, not by reaching into it.
    ;(run as { truth: unknown }).truth = { ...truth, anomalies: [] }
    runToCompletion(run)

    const constrained = [...run.jobs.values()].filter((j) => j.job.manifold === 'constrained')
    expect(constrained.length, 'no conduit work was announced with an empty oracle').toBeGreaterThan(0)
  })

  it('targets a named conduit at an arc, never a defect position', () => {
    const r = runToCompletion(
      createRun(
        house,
        defaultConfig({
          seed: 1,
          noiseMultiplier: 0,
          missionSeconds: 300,
          agents: [GROUND_BOT, INCHWORM],
          inchwormHomePort: 'sink-tail',
        }),
        spawn,
      ),
    )
    const constrained = [...r.jobs.values()].filter((j) => j.job.manifold === 'constrained')
    expect(constrained.length).toBeGreaterThan(0)
    const conduitIds = new Set([...graph.conduits.keys()])
    for (const j of constrained) {
      const c = j.job.conduit
      expect(c, 'a constrained job with no conduit target').toBeDefined()
      expect(conduitIds.has(c!.conduitId)).toBe(true)
      expect(Number.isFinite(c!.arc)).toBe(true)
      expect(c!.arc).toBeGreaterThanOrEqual(0)
      // Its capability requirement follows the bore, not a generic label.
      expect(j.job.requiredCapabilities.length).toBeGreaterThan(0)
    }
  })

  it('the inchworm raises only geometric suspicions, because it has no thermal sensor', () => {
    // Spec §3.2. What it *can* raise is a blockage seen by its range finder, and every
    // such finding is a suspicion below `CONFIDENCE_MIN` needing confirmation from an
    // agent that cannot reach it — which is the entire reason capability handoff
    // exists rather than being a convenience.
    //
    // Rewritten at Stage E part three. The previous version asserted the crawler raised
    // *nothing*, which was true only while it had no instrument at all, and would have
    // failed the moment the handoff gave it one.
    expect(INCHWORM.capabilities).not.toContain('sense.thermal')
    expect(INCHWORM.capabilities).not.toContain('sense.rgb')

    const r = runToCompletion(
      createRun(
        house,
        defaultConfig({
          seed: 1,
          noiseMultiplier: 1,
          missionSeconds: 300,
          agents: [GROUND_BOT, INCHWORM],
          inchwormHomePort: 'duct-drop-utility',
        }),
        spawn,
      ),
    )
    const fromCrawler = r.candidates.filter((c) => c.agentId === INCHWORM.id)
    expect(fromCrawler.length, 'the crawler reached a conduit with an obstruction in it').toBeGreaterThan(0)
    for (const c of fromCrawler) {
      expect(c.detectorId, 'the only instrument is a range finder').toBe('constrained.obstruction')
      expect(c.manifold).toBe('constrained')
      expect(c.unverified, 'a single sensor cannot corroborate itself').toBe(true)
      expect(c.confidence, 'a range finder cannot assert a class').toBeLessThan(0.6)
    }
  })
})
