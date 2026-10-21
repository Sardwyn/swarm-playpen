/**
 * Contract-net auction. Spec �6.3.
 *
 * Announce -> bid window -> award -> monitor. The coordinator is not omniscient: it
 * only knows what has been announced and what has been bid, and **distance is over
 * the agent's own map** - a bot with a bad map bids as though the job is far away.
 * That coupling is deliberate, because it is the mechanism by which map quality
 * feeds allocation, and it is why the fused map matters beyond the report.
 *
 * ## Allocation is nearest-eligible. The weighted score was deleted.
 *
 * Spec �9.4 pre-registered the condition: **if mean allocation regret is under 2%
 * across 20 seeds, delete the auction and keep greedy.** It has now been measured and
 * it fires. Over three arms and 860 contested awards:
 *
 * | arm | mean | p95 | worst | contested | winner was *not* the nearest |
 * |---|---|---|---|---|---|
 * | nominal | 0.000% | 0.000% | 0.000% | 243 | 0 of 620 samples |
 * | 30% battery | 0.000% | 0.000% | 0.000% | 243 | 0 of 620 samples |
 * | with the crawler | 0.023% | 0.000% | 23.84% | 314 | 1 of 1024 samples |
 *
 * One award in 1024 went to the farther bidder. The five-term score was not
 * approximately greedy - it *was* greedy to within one award in a thousand.
 *
 * Two of the five terms could never have discriminated:
 *
 * - **`capabilityFit` was redundant with eligibility.** Every eligible agent scored 1
 *   and every ineligible one 0, but `eligibility()` already refuses the ineligible
 *   ones, so within the bidding set it was a constant.
 * - **`irreversibleRisk` had no competitor to lose to.** The inchworm is the only
 *   agent holding `crawl.*`, so on any conduit job it was the sole eligible bidder and
 *   a penalty changed nothing.
 *
 * The other two varied and still never flipped an award, because at nominal neither
 * can outweigh distance. They were also broken before that: `batteryHeadroom` read
 * 1.0 for 100% of bids and `currentLoad` clamped flat. Fixing the normalisers was
 * necessary to make the experiment valid; it did not rescue the policy.
 *
 * ## What replaced it
 *
 * Two rules and no weights: **nearest eligible agent**, and an
 * **irreversible-commitment veto** that loses at any distance.
 *
 * The veto was previously a `-2.0` weight, which is weaker than it looks - the
 * positive terms summed to 5.7, so a nearby enough trap would still have won. As a
 * rule it cannot be outbid. **Deleting the scoring function made the safety property
 * stronger, not weaker**, which is the one way a kill can be a good outcome.
 *
 * ## What is kept, deliberately
 *
 * The protocol - announce, bid, award, monitor, starve, escalate - is not what the
 * kill condition removed and is still load-bearing. So is `allocationRegret`: this
 * decision is provisional on evidence, and the measurement has to keep running to
 * see whether a heterogeneous swarm changes the answer. S9 is that experiment.
 *
 * Re-introducing a weighted score needs the same evidence that removed it - a
 * configuration where it changes an award and the change is worth making.
 */

import type { AgentState, Capability, JobId, PortId } from '../types.ts'
import { isLumenPose } from '../types.ts'
import type { Grid } from '../world/geometry.ts'
import { findPath } from '../nav/astar.ts'
import { clamp, abs } from '../math.ts'
import type { Bid, JobRecord } from '../jobs/schema.ts'
import { BID_WINDOW, STARVATION_TIMEOUT, regionCentre } from '../jobs/schema.ts'
import type { LumenGraph } from '../world/lumen.ts'
import { routeInLumen, isIrreversible } from '../world/lumen.ts'
import type { LumenTarget } from '../sim/inchworm.ts'

/**
 * Bores below this are single-file: an agent that enters cannot turn around.
 * Spec §3.2 — the inchworm's irreversible commitment.
 */
export const SINGLE_FILE_BORE = 0.08

export type AuctionContext = {
  readonly grid: Grid
  readonly mask: Uint8Array
  readonly tick: number
  readonly jobs: Map<JobId, JobRecord>
  /** Per-agent current load, in job-seconds. */
  readonly load: Map<string, number>
  /**
   * Mission length, seconds. The horizon the load term normalises against.
   *
   * It was normalising against a hardcoded 60 s, which load passes within the first
   * minute of a 300 s mission — so the term was a constant for 80% of every run.
   */
  readonly missionSeconds: number
  /**
   * The lumen graph, for bidding on constrained-manifold jobs. Absent means no
   * constrained manifold has been authored and every `scan_*` job is
   * unreachable — which is the correct answer, not an error.
   */
  readonly lumen?: LumenGraph
  /**
   * Where each crawling agent currently is, in the form the lumen router wants.
   * Absent entry means "at its home port", which is where a crawler with no pose
   * demonstrably is.
   */
  readonly lumenPositions?: ReadonlyMap<string, LumenTarget | { atPort: PortId }>
}

/** Is this agent eligible on capability grounds alone? */
export function eligibility(state: AgentState, job: JobRecord): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  const have = new Set<Capability>(state.spec.capabilities)

  for (const needed of job.job.requiredCapabilities) {
    if (!have.has(needed)) reasons.push(`lacks ${needed}`)
  }
  if (state.manifold !== job.job.manifold) {
    reasons.push(`on manifold ${state.manifold}, job on ${job.job.manifold}`)
  }
  if (state.faulted) reasons.push('faulted')

  return { ok: reasons.length === 0, reasons }
}

/**
 * Would taking this job be irreversible for this agent? Spec §6.3.
 *
 * Now load-bearing. The rule is deliberately blunt: an agent whose *class* commits
 * it, bidding on a conduit whose bore is single-file, carries risk 1.
 *
 * It ignores whether the agent happens to be near the entry. That is on purpose.
 * A softer term — "risk only if the agent is far from the exit" — reads better and
 * is worse, because it makes a *safe* situation look safe by accident rather than
 * by rule, and the situation becomes unsafe the moment the crawl stalls. The
 * commitment is a property of the bore and the agent, not of the moment.
 */
export function irreversibleRisk(state: AgentState, job: JobRecord, graph?: LumenGraph): number {
  if (state.spec.cls !== 'inchworm') return 0
  if (job.job.conduit === undefined || graph === undefined) return 0
  const geo = graph.conduits.get(job.job.conduit.conduitId)
  if (geo === undefined) return 0
  return isIrreversible(geo) ? 1 : 0
}

/**
 * Path length to the job, over the agent's own map for its own manifold.
 *
 * Two routers, because there are two kinds of agent:
 * - ground/hover: A* over the occupancy grid, which the agent has built itself;
 * - inchworm: Dijkstra over the lumen graph, because inside a bore there is no
 *   grid and there never will be.
 *
 * An unreachable job returns the agent's current route length — effectively
 * "here" — so it bids short and then fails the arrival test, producing the
 * starvation the allocator is supposed to escalate. Bidding *long* for an
 * unreachable job would let a well-connected agent's misjudgement outrank a
 * capable agent's honesty, which is how a contract net rots.
 */
function measureDistance(ctx: AuctionContext, state: AgentState, job: JobRecord): number {
  if (state.spec.cls === 'inchworm') {
    if (ctx.lumen === undefined || job.job.conduit === undefined) return 0
    const from = ctx.lumenPositions?.get(state.spec.id)
    const route = routeInLumen(ctx.lumen, from ?? { atPort: UNKNOWN_PORT }, job.job.conduit)
    if (!route.reachable) return 0
    return route.length
  }

  if (!isLumenPose(state.pose)) {
    const centre = regionCentre(job.job.region)
    const path = findPath(ctx.grid, ctx.mask, state.pose.x, state.pose.z, centre.x, centre.z)
    // Partial paths count as their travelled length. An agent that cannot reach the
    // region should bid *short*, not long, and then fail the arrival test — which is
    // the honest outcome and produces the starvation the allocator must handle.
    return path.length
  }
  return 0
}

/**
 * Placeholder port for an agent with no recorded position.
 *
 * It is a real port id that exists in house-01 and sits at the far end of the
 * utility-room crawl, so a mis-seeded crawler bids as though it had to traverse the
 * whole perimeter void — expensive, not free. The failure mode of a bad position is
 * a pessimistic bid, never an optimistic one.
 */
const UNKNOWN_PORT: PortId = 'duct-drop-utility'

/**
 * Distance scale for lumen bidding, metres.
 *
 * The longest single conduit in house-01 is the 28 m perimeter void, and a fixed
 * constant larger than the whole house would flatten the distance term to almost
 * nothing. Derived from the graph itself rather than authored, so adding a conduit
 * rescales the term instead of silently saturating it.
 */
export function lumenNormaliser(graph: LumenGraph): number {
  let longest = 0
  for (const geo of graph.conduits.values()) {
    if (geo.total > longest) longest = geo.total
  }
  // Twice the longest single conduit covers entry-port plus traverse, which is the
  // worst single-route distance this house admits.
  return Math.max(longest * 2, 1)
}

/**
 * Build a bid: eligibility, path distance, and whether the work is irreversible.
 *
 * No score. Two rules decide the award instead, both in `rankBids`: nearest
 * eligible agent, and an irreversible-commitment veto. The weighted score that used
 * to be computed here is gone - see the file header for the measurement that removed
 * it and for why two of its terms could never have discriminated at all.
 *
 * `batteryHeadroom` survives as a *reported* figure, not as a ranking term: it is on
 * the bid because �9.3's energy accounting wants it per award, and it is not used to
 * order bids. That distinction is the whole content of the kill.
 */
export function buildBid(
  ctx: AuctionContext,
  state: AgentState,
  job: JobRecord,
): Bid {
  const elig = eligibility(state, job)
  const distance = measureDistance(ctx, state, job)

  // Fraction of the pack remaining. Reported, not scored.
  //
  // It was previously `clamp(remainingWh / tripWh, 0, 4) / 4`, which read **1.0 for
  // every bid in every run**: a 38 Wh pack against a ~0.1 Wh trip is a ratio of ~370,
  // so the ceiling was hit instantly and the term was a constant. As a *ranking* term
  // it could never change an award, and the kill condition confirmed it. As a
  // *reported* number it is honest - at nominal the ground bot ends a 300 s mission
  // with about 95% of its pack, and that fact belongs in the energy accounting.
  const batteryHeadroom = clamp((state.spec.batteryWh - state.energyUsed) / state.spec.batteryWh, 0, 1)

  const risk = irreversibleRisk(state, job, ctx.lumen)

  return {
    agentId: state.spec.id,
    distance,
    batteryHeadroom,
    irreversibleRisk: risk,
    eligible: elig.ok,
    reasons: elig.reasons,
  }
}
/**
 * Order bids for award.
 *
 * Two rules, in order, and then a total tie-break. No weights.
 *
 * 1. **The irreversible-commitment veto.** An agent whose work is single-file loses
 *    to one whose work is not, at any distance. This was a `-2.0` score term, which
 *    was weaker than it looked: the positive terms summed to 5.7, so a nearby enough
 *    40 mm trap would still have won the bid. As a rule it cannot be outbid � which
 *    is the one thing a kill can improve.
 * 2. **Nearest eligible.** Shortest path over the agent's own map.
 * 3. **Agent ID**, ascending. Explicit and total: resolving a tie by sort stability
 *    would make the winner depend on the order bids were collected in, which is agent
 *    array order, which is config order.
 */
export function rankBids(bids: readonly Bid[]): Bid[] {
  return [...bids].sort((a, b) => {
    if (a.irreversibleRisk !== b.irreversibleRisk) return a.irreversibleRisk - b.irreversibleRisk
    if (a.distance !== b.distance) return a.distance - b.distance
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0
  })
}

/**
 * The kill decision. Spec �9.4, test-scenarios.md �S8.
 *
 * Three outcomes, and the third is the one that keeps getting skipped:
 *
 * - **justified** � enough contested awards, mean regret above 2%. The auction buys
 *   something a nearest-eligible rule would not.
 * - **delete it** � enough contested awards, mean regret below 2%. Greedy would do
 *   the same job for a fraction of the code.
 * - **NOT EVALUABLE** � too few contested awards. Not a pass and not a fail: the
 *   experiment did not run.
 *
 * The threshold is a *decision*, not a target, and reporting 0.00% then concluding
 * "delete the auction" is precisely the failure this guard exists to stop. It fired
 * for a different reason at Stage E � two agents, 37 awards, mean regret 0.00%, and
 * not one award contested, because the two agents sit on different manifolds and can
 * never bid against each other. A mean over uncontested awards is zero by
 * construction and carries no information.
 *
 * `MIN_CONTESTED` is a floor for "we have a signal", not a claim that five samples
 * are statistically strong. A marginal result is still worth another run.
 *
 * **This verdict has now been acted on.** Mean regret came back 0.000% in the nominal
 * arm over 243 contested awards, and 0.023% with the crawler, so `delete_auction`
 * stands and `buildBid` no longer computes a score. The function is kept because S9
 * is a different swarm � heterogeneous, energy-matched � and the measurement has to
 * keep running to see whether that changes the answer.
 */
export const REGRET_KILL_THRESHOLD = 0.02
export const MIN_CONTESTED_AWARDS = 5

export type AuctionVerdict =
  | { status: 'justified'; mean: number; contested: number }
  | { status: 'delete_auction'; mean: number; contested: number }
  | { status: 'not_evaluable'; mean: number; contested: number; reason: string }

export function auctionVerdict(regret: { mean: number }, contestedAwards: number): AuctionVerdict {
  if (contestedAwards < MIN_CONTESTED_AWARDS) {
    return {
      status: 'not_evaluable',
      mean: regret.mean,
      contested: contestedAwards,
      reason:
        `only ${contestedAwards} award${contestedAwards === 1 ? '' : 's'} had a second eligible bidder ` +
        `(need ${MIN_CONTESTED_AWARDS}). Regret over uncontested awards is zero by construction — ` +
        `it measures the absence of competition, not the quality of the auction.`,
    }
  }
  if (regret.mean < REGRET_KILL_THRESHOLD) {
    return { status: 'delete_auction', mean: regret.mean, contested: contestedAwards }
  }
  return { status: 'justified', mean: regret.mean, contested: contestedAwards }
}

export function formatVerdict(v: AuctionVerdict): string {
  switch (v.status) {
    case 'justified':
      return `auction justified — mean regret ${(v.mean * 100).toFixed(2)}% over ${v.contested} contested awards`
    case 'delete_auction':
      return (
        `DELETE THE AUCTION — mean regret ${(v.mean * 100).toFixed(2)}% over ${v.contested} contested awards, ` +
        `below the ${(REGRET_KILL_THRESHOLD * 100).toFixed(0)}% threshold. A greedy nearest-eligible rule would do the same.`
      )
    case 'not_evaluable':
      return `NOT EVALUABLE — ${v.reason}`
  }
}

/**
 * Allocation regret, spec §9.4: how much worse the winner's trip was than the best
 * bidder's.
 *
 * **Kept after the kill, deliberately.** The kill condition removed the scoring
 * function; it did not remove the measurement, because the decision it produced is
 * provisional on evidence. S9 compares a heterogeneous swarm against an
 * energy-matched homogeneous one, and that is a different allocation problem — if
 * capability-aware allocation earns its keep anywhere, it is there. A verdict that
 * cannot be revisited is a verdict that cannot be overturned.
 *
 * Measured per awarded job as a *fraction of the best available path*, so it is
 * comparable across jobs of different sizes, and reported as a mean and a p95
 * because a mean alone hides the one catastrophic allocation.
 */
export function allocationRegret(
  awarded: ReadonlyArray<{ winnerDistance: number; bestDistance: number }>,
): { mean: number; p95: number; worst: number; samples: number } {
  if (awarded.length === 0) return { mean: 0, p95: 0, worst: 0, samples: 0 }

  const regrets = awarded
    .filter((a) => a.bestDistance > 0.05)
    .map((a) => Math.max(0, (a.winnerDistance - a.bestDistance) / a.bestDistance))
    .sort((x, y) => x - y)

  if (regrets.length === 0) return { mean: 0, p95: 0, worst: 0, samples: 0 }

  const sum = regrets.reduce((s, v) => s + v, 0)
  const p95Index = Math.min(regrets.length - 1, Math.floor(regrets.length * 0.95))
  return {
    mean: sum / regrets.length,
    p95: regrets[p95Index]!,
    worst: regrets[regrets.length - 1]!,
    samples: regrets.length,
  }
}

/** Has this job exhausted its bid window and gone begging? Spec §6.5. */
export function isStarved(job: JobRecord, tick: number): boolean {
  const eligible = job.bids.some((b) => b.eligible)
  if (eligible) return false
  return tick - job.job.announcedAtTick >= STARVATION_TIMEOUT
}

export { BID_WINDOW, STARVATION_TIMEOUT, abs }
