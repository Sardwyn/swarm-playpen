/**
 * The inchworm. Spec §3.2, §5.3, §6.4.
 *
 * ## Three things it cannot do, and each one matters
 *
 * 1. **No thermal sensor.** It can reach defects it can never confirm. So every
 *    finding it produces is a *suspicion* that escalates to another agent through
 *    a port (spec §6.4 mechanism 1). That is why handoff exists for capability
 *    rather than only for distance.
 * 2. **Single-file below 80 mm.** Entering the 40 mm waste run is a commitment to
 *    the full traverse; the only way out is the far end. Being trapped by a job
 *    assignment is a failure the system must avoid, and `irreversibleRisk` in the
 *    auction (§6.3) is what avoids it.
 * 3. **It cannot recalibrate.** It cannot reach a port mid-conduit without
 *    abandoning and re-entering the bore, so it holds no `recal.port` capability.
 *    Per spec §4.5.1 that makes it the one agent whose accuracy monotonically
 *    degrades over a mission and cannot be restored.
 *
 * ## Localisation is graph-relational, and has to be
 *
 * There is no isometric 2-D patch inside a bore, so scan matching — which is what
 * the ground bot uses — has nothing to match against. Pose here is
 * `(conduit, arc, offset)`: three numbers, not a metric pose.
 *
 * So localisation is graph-relational (spec §5.3): odometry along the arc with
 * drift, corrected when the agent passes an authored feature node. The under-floor
 * void is an 18 m loop, so it is the one structure in the house that lets the agent
 * close a loop, and it is therefore the test of whether drift is bounded or
 * unbounded.
 */

import type { AgentState, PoseLumen } from '../types.ts'
import { DT, MISSION_DRIFT_HORIZON } from '../types.ts'
import type { LumenGraph, ConduitGeometry, LumenRoute } from '../world/lumen.ts'
import { routeInLumen, featureNear, clampArc, canEnter } from '../world/lumen.ts'
import type { Rng } from '../rng.ts'
import type { EventLog } from '../eventlog.ts'
import { abs, clamp } from '../math.ts'
import { residualBiasFraction } from './agents.ts'

/**
 * Per-agent lumen state. Held in the run, never in module scope (ADR-001 §2.4).
 *
 * `atPort` is the mode outside a conduit: the agent is standing at a manifold
 * boundary and can only take work whose region is within reach of that port,
 * because it holds no `ground.drive` capability.
 */
export type InchwormState = {
  /** null when standing at a port. `pose.arc` is the agent's *believed* position. */
  pose: PoseLumen | null
  atPort: string | null
  /**
   * Distance actually crawled, metres — the **true** figure.
   *
   * `pose.arc` is the agent's *believed* position, and it is this number that
   * disagrees with it: the drive train over-reports by `ODOMETRY_SCALE_ERROR`, so
   * the believed arc runs ahead of the truth and only a landmark brings them back
   * together. Naming the true figure "odometry" was actively misleading — odometry
   * is the estimate, not the ground truth — so it is `travelledM`.
   */
  travelledM: number
  /**
   * Landmarks already passed, keyed `conduitId:kind:arc`.
   *
   * A map rather than a single "last feature", because a closure is a *revisit* of
   * any earlier landmark. With only the previous landmark recorded, a second pass
   * over three nodes looks like two closures instead of three, and a feature the
   * agent passes on every lap stops being distinguishable from one it passes once.
   */
  seenFeatures: Map<string, { authoredArc: number; integratedArc: number }>
  /**
   * The landmark the agent is currently within tolerance of, or null.
   *
   * This latch is load-bearing and its absence is a bug I made: the first version
   * tested `featureNear(arc, step + 1e-6)` and updated `lastFeature` on every tick
   * it was anywhere near a landmark. The agent therefore counted a closure on
   * *every tick* it sat beside a node — 2638 "closures" over 25 m of travel — and
   * the snap-back to the authored arc fought the forward step, pinning the crawler
   * in a 1 m loop. Coverage read 10.7% and the drift rate read a confident 0.085 m
   * per 10 m. Both numbers were fiction produced by a test that re-fired.
   *
   * A landmark must be *entered*, not merely *near*, and the latch is what
   * distinguishes the two.
   */
  activeFeature: string | null
  /** Loop closures performed. A metric, not a debug counter (§9.3). */
  closures: number
  /** |believed − authored| at each closure, with the distance crawled to get there. */
  driftSamples: DriftSample[]
  /** True distance at the most recent closure, for leg measurement. */
  lastClosureM: number | null
  /** Humidity lag state, per spec §4.3. */
  rhFiltered: number
  initialised: boolean
  route: LumenRoute | null
  routeIndex: number
}

export function createInchwormState(): InchwormState {
  return {
    pose: null,
    atPort: null,
    travelledM: 0,
    seenFeatures: new Map(),
    activeFeature: null,
    closures: 0,
    driftSamples: [],
    lastClosureM: null,
    rhFiltered: 0,
    initialised: false,
    route: null,
    routeIndex: 0,
  }
}

/** Metres actually crawled. The *true* distance, which `pose.arc` disagrees with. */
export function crawledDistance(inch: InchwormState): number {
  return inch.travelledM
}

/** How far the agent's believed position has drifted from the true travelled distance. */
export function believedError(inch: InchwormState): number {
  if (inch.pose === null || inch.pose.conduitId === '') return 0
  return abs(inch.pose.arc) - inch.travelledM
}

/** A conduit target: which conduit, and how far along it. */
export type LumenTarget = {
  readonly conduitId: string
  readonly arc: number
}

export type InchwormContext = {
  readonly graph: LumenGraph
  readonly rng: Rng
  readonly log: EventLog
  readonly tick: number
  readonly noiseMultiplier: number
  /** Conduit job currently held, or null when idle. */
  readonly job: LumenTarget | null
  /** Port the agent starts and idles at. */
  readonly homePort: string
}

export type InchwormResult = {
  readonly state: AgentState
  readonly inch: InchwormState
  readonly moved: number
  readonly arrived: boolean
  /** True on a tick where a loop closure corrected the pose. */
  readonly drifted: boolean
}

/** The agent's position in the form the router wants. */
export function graphPosOf(inch: InchwormState, homePort: string): { conduitId: string; arc: number } | { atPort: string } {
  if (inch.pose !== null) return { conduitId: inch.pose.conduitId, arc: inch.pose.arc }
  return { atPort: inch.atPort ?? homePort }
}

/**
 * One tick: hold a route, walk it, correct on features.
 *
 * There is no frontier exploration here, deliberately. The inchworm is a *serviced*
 * agent — it takes conduit jobs and returns. Frontier exploration belongs to the
 * ground bot, and pretending the inchworm explores is how a simulation ends up
 * claiming coverage in places no robot could physically fit.
 */
export function tickInchworm(
  state: AgentState,
  inch: InchwormState,
  ctx: InchwormContext,
): InchwormResult {
  let moved = 0
  let drifted = false

  const routeSpent = inch.route === null || inch.routeIndex >= inch.route.steps.length
  const needsPlan = routeSpent || (ctx.job !== null && !routeServes(inch.route, ctx.job))

  if (needsPlan) {
    if (ctx.job === null) {
      inch.route = null
    } else {
      const route = routeInLumen(ctx.graph, graphPosOf(inch, ctx.homePort), ctx.job)
      inch.route = route.reachable ? route : null
      inch.routeIndex = 0
      if (!route.reachable) {
        // A job in a conduit this agent cannot enter, or with no port path. That
        // is an allocation error worth logging rather than a silent no-op.
        ctx.log.push({
          tick: ctx.tick,
          kind: 'job.failed',
          agentId: state.spec.id,
          data: { reason: route.blockedReason === null ? 0 : 1 },
        })
      }
    }
  }

  if (inch.route !== null && !isAtTarget(inch, ctx.job)) {
    const step = inch.route.steps[inch.routeIndex]
    if (step === undefined) {
      inch.route = null
    } else {
      const geo = ctx.graph.conduits.get(step.conduitId)
      if (geo === undefined) {
        inch.route = null
      } else if (!canEnter(geo, state.spec.capabilities)) {
        // Should be impossible: the auction should never award a conduit job to an
        // agent that cannot enter the conduit. Logged rather than clamped, so a
        // capability bug is visible instead of becoming a silent teleport.
        ctx.log.push({
          tick: ctx.tick,
          kind: 'job.failed',
          agentId: state.spec.id,
          data: { reason: 2 },
        })
        inch.route = null
      } else {
        const result = traverse(geo, step.fromArc, step.toArc, state, inch, ctx)
        moved = result.moved
        drifted = result.drifted
        inch.routeIndex++
        if (inch.routeIndex >= inch.route.steps.length) inch.route = null
      }
    }
  }

  // Energy. Spec §9.5 — the subsystem split is what makes the 86 W hover draw
  // legible, and the same applies here: 9 W crawl + 8 W sensors on a 12 Wh pack.
  const watts = moved > 0 ? state.spec.powerCruise + state.spec.powerSensors : state.spec.powerSensors * 0.6
  const wh = (watts * DT) / 3600

  const battery = clamp(state.battery - wh / state.spec.batteryWh, 0, 1)
  const faulted = battery <= 0

  if (faulted && !state.faulted) {
    ctx.log.push({ tick: ctx.tick, kind: 'agent.faulted', agentId: state.spec.id, data: { reason: 3 } })
  }

  return {
    state: {
      ...state,
      manifold: 'constrained',
      energyUsed: state.energyUsed + wh,
      battery,
      faulted,
      ticksSinceCalibration: state.ticksSinceCalibration + 1,
      tickPathLength: moved,
    },
    inch,
    moved,
    arrived: isAtTarget(inch, ctx.job),
    drifted,
  }
}

/** Does the current route still end at the job's target? */
function routeServes(route: LumenRoute | null, job: LumenTarget | null): boolean {
  if (route === null || job === null) return false
  const last = route.steps[route.steps.length - 1]
  return last !== undefined && last.conduitId === job.conduitId && abs(last.toArc - job.arc) < 1e-6
}

export function isAtTarget(inch: InchwormState, job: LumenTarget | null): boolean {
  if (job === null || inch.pose === null) return false
  if (inch.pose.conduitId !== job.conduitId) return false
  return abs(inch.pose.arc - job.arc) < 0.12
}

/**
 * Walk a conduit from one arc to another, correcting on feature nodes.
 *
 * ## The correction is the whole content of loop closure here
 *
 * On a one-dimensional manifold, a revisited landmark fixes the coordinate
 * *completely*. There is no residual to minimise and no pose graph, and that is not
 * a simplification — it is what confinement buys. The consequence is that drift is
 * **bounded by the spacing between landmarks** rather than growing without limit,
 * which is the claim `worstCaseDriftBound` turns into a number for the report.
 *
 * ## Where the drift comes from
 *
 * The agent integrates its commanded motion and gets a slightly wrong answer: a
 * scale error on the drive train. `ODOMETRY_SCALE_ERROR` is the fractional
 * mis-measurement, and it is applied to the *believed* distance only. So the
 * believed position walks away from truth at a constant rate, the correction at a
 * landmark is the size of that accumulated error, and `driftSamples` records it.
 *
 * The first version applied no drift at all, which made the closure metric
 * structurally incapable of showing anything: it measured 0.085 m per 10 m of pure
 * numerical noise and reported it with three significant figures. A SLAM metric
 * that cannot fail is not a metric.
 */
function traverse(
  geo: ConduitGeometry,
  fromArc: number,
  toArc: number,
  state: AgentState,
  inch: InchwormState,
  ctx: InchwormContext,
): { moved: number; drifted: boolean } {
  const from = clampArc(geo, fromArc)
  const to = clampArc(geo, toArc)
  const direction = to >= from ? 1 : -1

  // Resume from where we actually are if we are already in this conduit; otherwise
  // enter at the step's start.
  const arc =
    inch.pose !== null && inch.pose.conduitId === geo.conduit.id ? clampArc(geo, inch.pose.arc) : from

  // Speed is reduced by the residual calibration bias: the same drift source that
  // corrupts the odometry estimate also degrades the motion estimate, and charging
  // the agent for it is what makes the calibration decay (§4.5.1) cost something
  // real rather than being decorative.
  const secondsSinceCal = inch.initialised ? state.ticksSinceCalibration * DT : 0
  const speedFactor = 1 - 0.3 * residualBiasFraction(secondsSinceCal)

  // Distance to cover, and how far the drive train actually reports covering it.
  const remaining = abs(to - arc)
  const step = Math.min(state.spec.cruiseSpeed * speedFactor * DT, remaining)
  const believedStep = step * (1 + ODOMETRY_SCALE_ERROR)

  const advanced = clampArc(geo, arc + direction * believedStep)
  inch.travelledM += step
  inch.initialised = true
  inch.pose = { conduitId: geo.conduit.id, arc: advanced, offset: 0, roll: 0 }

  let drifted = false
  drifted = checkFeature(geo, advanced, state, inch, ctx)

  return { moved: step, drifted }
}

/**
 * Landmark latch and closure, on entry rather than on proximity.
 *
 * `featureNear` with a tolerance of one step re-fires every tick the agent is
 * beside a node, which is what produced 2638 closures and a stalled crawler. The
 * latch means a landmark is handled once per *visit*: the agent must leave the
 * tolerance band before it can be counted again.
 */
function checkFeature(
  geo: ConduitGeometry,
  arc: number,
  state: AgentState,
  inch: InchwormState,
  ctx: InchwormContext,
): boolean {
  const feature = featureNear(geo, arc, FEATURE_TOLERANCE)

  if (feature === null) {
    inch.activeFeature = null
    return false
  }

  const key = `${geo.conduit.id}:${feature.kind}:${feature.arc.toFixed(3)}`
  if (inch.activeFeature === key) {
    // Still inside the same landmark's band. Not a new sighting.
    return false
  }
  inch.activeFeature = key

  const prior = inch.seenFeatures.get(key)
  if (prior === undefined) {
    // First fix: record where this landmark sits. No error to report — there is
    // nothing to disagree with yet.
    inch.seenFeatures.set(key, { authoredArc: feature.arc, integratedArc: inch.travelledM })
    return false
  }

  // Revisit. The believed position has walked away from the authored one, and the
  // size of that disagreement is the drift this landmark just corrected.
  const error = abs(arc - feature.arc)
  const legMetres = inch.travelledM - (inch.lastClosureM ?? prior.integratedArc)
  inch.driftSamples.push({ error, legMetres })
  inch.lastClosureM = inch.travelledM
  inch.closures++

  // Correct: on a 1-D manifold the landmark fixes the coordinate completely.
  inch.pose = { conduitId: geo.conduit.id, arc: feature.arc, offset: 0, roll: 0 }

  ctx.log.push({
    tick: ctx.tick,
    kind: 'agent.loop_closed',
    agentId: state.spec.id,
    manifold: 'constrained',
    data: { error, correctedToArc: feature.arc, closures: inch.closures },
  })

  return true
}

/**
 * Half-width of a landmark's latch band, metres.
 *
 * Kept small relative to the drift it is meant to measure, and that constraint is
 * load-bearing. A landmark fires when the agent is *near* it, so the correction
 * applied is the drift **plus** whatever offset the agent happened to be at inside
 * the band. At the first cut's 12 cm the detection offset dominated: over an 8 m leg
 * the drive train's error is 6.4 cm, so a 12 cm band means the reported "drift" was
 * mostly the band and the metric could not distinguish a well-calibrated crawler
 * from a badly calibrated one.
 *
 * At 4 cm the offset is well under the drift over a realistic leg, so the reported
 * correction is dominated by the thing it claims to measure. It must still exceed
 * one tick of travel (0.9 cm) or the agent would step over the landmark and the
 * whole mechanism would silently never fire.
 */
export const FEATURE_TOLERANCE = 0.04

/**
 * Fractional mis-measurement of the drive train, per metre crawled.
 *
 * 0.8% is a plausible figure for a cheap inchworm's joint encoders and is
 * **not** a tuning parameter for a good result. It is the drift that makes loop
 * closure worth having: at 0.8%, an agent that has not seen a landmark for 20 m is
 * 16 cm wrong, which is larger than the 12 cm arrival tolerance for a survey job —
 * so without closure the crawler would start failing jobs it had physically
 * reached.
 */
export const ODOMETRY_SCALE_ERROR = 0.008

/**
 * Drift in metres per 10 m travelled, from the closure samples.
 *
 * A *rate*, so it has to be error per metre — normalised by the distance actually
 * crawled between one closure and the next. The first version returned
 * `mean(error) * 10`, which is not a rate at all: it is the mean correction scaled
 * by an arbitrary ten, so it grew with the spacing between landmarks rather than
 * with the drive train's error. It reported 1.15 m per 10 m on a conduit whose
 * uncorrected drift was 0.22 m per 10 m — a "drift" larger than the drift it was
 * supposed to be measuring, with three significant figures and no error bar.
 *
 * Null when no closure has happened — which is the honest answer for a run that never
 * revisited a landmark, and not a zero.
 */
export function driftRatePer10m(inch: InchwormState): number | null {
  if (inch.driftSamples.length === 0) return null

  let ratioSum = 0
  let counted = 0
  for (const s of inch.driftSamples) {
    if (s.legMetres <= 0) continue
    ratioSum += s.error / s.legMetres
    counted++
  }
  if (counted === 0) return null
  return (ratioSum / counted) * 10
}

/** One closure: how far the believed position had walked away, over how far it crawled. */
export type DriftSample = {
  readonly error: number
  /** True distance crawled since the previous closure. */
  readonly legMetres: number
}

/**
 * Bounded or unbounded?
 *
 * On a one-dimensional manifold with authored landmarks the answer is *bounded*:
 * the pose is snapped at every landmark, so the worst-case error is the largest gap
 * between consecutive fixes, not the distance travelled. This helper returns that
 * gap so the claim is a number in the report rather than an assertion in a comment.
 *
 * The conduit's **endpoints count as fixes**, which is what makes this total. The
 * agent enters at a known arc and a port is a known position, so it does not drift
 * from the mouth until it passes the first landmark. Without that, a conduit with a
 * single landmark returned null — "no bound known" — when in fact it had a very
 * large one, and a missing bound reads as an unanalysed system rather than a badly
 * instrumented one.
 *
 * Null only when the conduit does not exist or has no fixes at all.
 */
export function worstCaseDriftBound(graph: LumenGraph, conduitId: string): number | null {
  const geo = graph.conduits.get(conduitId)
  if (geo === undefined) return null

  const arcs = [0, ...geo.conduit.features.map((f) => f.arc), geo.total].sort((a, b) => a - b)
  if (arcs.length < 2) return null

  let worst = 0
  for (let i = 1; i < arcs.length; i++) {
    const gap = arcs[i]! - arcs[i - 1]!
    if (gap > worst) worst = gap
  }
  return worst
}

export { MISSION_DRIFT_HORIZON }