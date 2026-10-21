/**
 * The lumen graph. Spec §2.2, §5.3.
 *
 * ## Why a graph and not a volume
 *
 * The constrained manifold is a set of swept polylines. An inchworm inside one has
 * **one** real degree of freedom — arc length — plus a small bounded lateral offset.
 * Modelling that as a 3-D occupancy volume would be the comfortable choice and it
 * would be a lie: it makes the navigation problem look like ordinary grid
 * navigation, and it hides the fact that there is no isometric 2-D patch inside a
 * bore for scan matching to use.
 *
 * So this is a graph over *ports*, with conduits as edges. Routing is Dijkstra over
 * ports; motion within a conduit is one-dimensional. Everything awkward about
 * confined-space robotics follows from that and is therefore visible here rather
 * than hidden under a volume.
 *
 * ## Loops
 *
 * A conduit may carry the **same port at both ends** — the under-floor void does,
 * which is a 18 m perimeter crawl returning to its own entry. That is not a special
 * case; it is just an edge whose endpoints coincide, and the graph handles it. It
 * matters because it is the only structure in the house that lets the inchworm
 * close a loop, and loop closure is what bounds arc-length drift (§5.3).
 */

import type { Conduit, PortId } from '../types.ts'
import { sqrt } from '../math.ts'

export type ConduitGeometry = {
  readonly conduit: Conduit
  /** Cumulative arc length at each centreline point. Length n = points. */
  readonly cumulative: readonly number[]
  /** Total arc length. */
  readonly total: number
  /** Bore class, from spec §10. */
  readonly class: 'small' | 'medium' | 'large'
}

export type LumenGraph = {
  readonly conduits: ReadonlyMap<string, ConduitGeometry>
  /** Ports each conduit endpoint opens onto. */
  readonly endpoints: ReadonlyMap<string, { start?: PortId; end?: PortId }>
  /** Conduits reachable from a port, with the port they are entered at. */
  readonly fromPort: ReadonlyMap<PortId, readonly { conduitId: string; atEnd: 'start' | 'end' }[]>
}

const SMALL_BORE = 0.08
const MEDIUM_BORE = 0.25

export function boreClass(bore: number): 'small' | 'medium' | 'large' {
  if (bore <= SMALL_BORE) return 'small'
  if (bore <= MEDIUM_BORE) return 'medium'
  return 'large'
}

export function buildLumenGraph(conduits: readonly Conduit[]): LumenGraph {
  const geo = new Map<string, ConduitGeometry>()
  const endpoints = new Map<string, { start?: PortId; end?: PortId }>()
  const fromPort = new Map<PortId, Array<{ conduitId: string; atEnd: 'start' | 'end' }>>()

  for (const c of conduits) {
    if (c.points.length < 2) {
      throw new Error(`conduit '${c.id}' needs at least two centreline points`)
    }

    const cumulative: number[] = [0]
    for (let i = 1; i < c.points.length; i++) {
      const a = c.points[i - 1]!
      const b = c.points[i]!
      const d = sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2)
      cumulative.push(cumulative[i - 1]! + d)
    }
    const total = cumulative[cumulative.length - 1]!

    if (total <= 0) {
      throw new Error(`conduit '${c.id}' has zero length`)
    }

    // Features must lie on the conduit. A feature past the end would make loop
    // closure untriggerable, which is precisely the kind of authoring slip that
    // presents as "the SLAM is inaccurate".
    for (const f of c.features) {
      if (f.arc < 0 || f.arc > total) {
        throw new Error(
          `conduit '${c.id}' feature at arc ${f.arc} lies outside [0, ${total.toFixed(3)}]`,
        )
      }
    }

    geo.set(c.id, { conduit: c, cumulative, total, class: boreClass(c.bore) })
    endpoints.set(c.id, { start: c.startPort, end: c.endPort })

    if (c.startPort !== undefined) push(fromPort, c.startPort, { conduitId: c.id, atEnd: 'start' })
    if (c.endPort !== undefined) push(fromPort, c.endPort, { conduitId: c.id, atEnd: 'end' })
  }

  return { conduits: geo, endpoints, fromPort }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k) ?? []
  list.push(v)
  m.set(k, list)
}

/** World position at an arc position. */
export function positionAt(g: ConduitGeometry, arc: number): [number, number, number] {
  const clamped = clampArc(g, arc)
  const { cumulative, conduit } = g

  for (let i = 1; i < cumulative.length; i++) {
    const end = cumulative[i]!
    if (clamped > end && i < cumulative.length - 1) continue
    const start = cumulative[i - 1]!
    const segLength = end - start
    const t = segLength <= 0 ? 0 : (clamped - start) / segLength
    const a = conduit.points[i - 1]!
    const b = conduit.points[i]!
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
  }

  const last = conduit.points[conduit.points.length - 1]!
  return [last[0], last[1], last[2]]
}

export function clampArc(g: ConduitGeometry, arc: number): number {
  if (arc < 0) return 0
  if (arc > g.total) return g.total
  return arc
}

/** Which feature (if any) is within `tolerance` of this arc. */
export function featureNear(g: ConduitGeometry, arc: number, tolerance = 0.08): ConduitGeometry['conduit']['features'][number] | null {
  let best: (typeof g.conduit.features)[number] | null = null
  let bestDistance = tolerance
  for (const f of g.conduit.features) {
    const d = abs(f.arc - arc)
    if (d <= bestDistance) {
      bestDistance = d
      best = f
    }
  }
  return best
}

/**
 * Can this agent physically enter the conduit at all? Spec §3.2.
 *
 * `crawl.small` reaches bores ≤80 mm, `crawl.medium` reaches ≤250 mm, and the
 * classes are nested: an agent that can handle 250 mm can certainly handle 40 mm,
 * so `medium` implies `small`. The converse is false, and writing it the other way
 * round — `medium || small` for every class, which the first cut did — let a
 * small-bore crawler enter the 120 mm kitchen extract and then wedge in it.
 */
export function canEnter(g: ConduitGeometry, capabilities: readonly string[]): boolean {
  const hasSmall = capabilities.includes('crawl.small')
  const hasMedium = capabilities.includes('crawl.medium')
  if (g.class === 'small') return hasSmall || hasMedium
  return hasMedium
}

/**
 * Is entering this conduit irreversible?
 *
 * Spec §3.2: the 40 mm waste run is single-file, so once the inchworm is in, the
 * only way out is the far end. `irreversibleRisk` in the auction (§6.3) reads this,
 * and it is the term that stops the swarm bidding an agent into a trap.
 */
export function isIrreversible(g: ConduitGeometry): boolean {
  return g.conduit.bore <= SMALL_BORE
}

export type LumenPathStep = {
  readonly conduitId: string
  /** Traverse the conduit from this arc to this arc. */
  readonly fromArc: number
  readonly toArc: number
  /** True when this step ends at a port the agent can exit from. */
  readonly exitsAtPort: PortId | null
}

export type LumenRoute = {
  readonly steps: readonly LumenPathStep[]
  readonly reachable: boolean
  /** Why not, when unreachable. */
  readonly blockedReason: string | null
  /** Total path length, metres. Feeds allocation distance honestly. */
  readonly length: number
  /** True if any step is a single-file commitment. */
  readonly irreversible: boolean
}

/**
 * Route from the inchworm's current pose to a target arc in some conduit.
 *
 * Deliberately simple: the agent is at (conduit, arc) or standing at a port. It
 * exits to a port, walks the port graph, and re-enters. Since only the inchworm
 * uses this and there are six conduits, the naive form is also the honest one —
 * a clever planner here would be solving a problem Stage E does not have yet.
 *
 * This is the only routing entry point. There was briefly a second one,
 * `routeToArc`, that patched the final arc after the fact — and because the patch
 * was applied to the step list but recomputed against the *unpatched* length, it
 * reported 28.3 m for a 2 m hop on a loop. Two functions that differ only in
 * whether they are finished is one too many.
 */
export function routeInLumen(
  graph: LumenGraph,
  from: { conduitId: string; arc: number } | { atPort: PortId },
  to: { conduitId: string; arc: number },
): LumenRoute {
  const steps: LumenPathStep[] = []
  let length = 0
  let irreversible = false

  const target = graph.conduits.get(to.conduitId)
  if (target === undefined) {
    return { steps: [], reachable: false, blockedReason: `unknown conduit '${to.conduitId}'`, length: 0, irreversible: false }
  }

  // Case 1: already in the target conduit. Just walk the arc.
  if ('conduitId' in from) {
    if (from.conduitId === to.conduitId) {
      const g = graph.conduits.get(from.conduitId)!
      const d = abs(to.arc - from.arc)
      length += d
      if (isIrreversible(g)) irreversible = true
      steps.push({
        conduitId: from.conduitId,
        fromArc: from.arc,
        toArc: to.arc,
        exitsAtPort: arcAtPort(g, to.arc),
      })
      return { steps, reachable: true, blockedReason: null, length, irreversible }
    }
  }

  // Case 2: leave the current conduit (or start at a port) via a port, then walk
  // the port graph to the target conduit.
  const originPorts = originPortsOf(graph, from)
  if (originPorts.length === 0) {
    return {
      steps: [],
      reachable: false,
      blockedReason: 'not at a port and not in a conduit that opens onto one',
      length: 0,
      irreversible: false,
    }
  }

  let best: { port: PortId; steps: LumenPathStep[]; length: number; irreversible: boolean } | null = null

  for (const startPort of originPorts) {
    const walk = dijkstra(graph, startPort, target, to.arc)
    if (walk === null) continue
    if (best === null || walk.length < best.length) {
      best = { port: startPort, steps: walk.steps, length: walk.length, irreversible: walk.irreversible }
    }
  }

  if (best === null) {
    return {
      steps: [],
      reachable: false,
      blockedReason: `no port path from ${originPorts.join('/')} to a conduit serving '${to.conduitId}'`,
      length: 0,
      irreversible: false,
    }
  }

  return {
    steps: best.steps,
    reachable: true,
    blockedReason: null,
    length: best.length,
    irreversible: best.irreversible,
  }
}

function originPortsOf(
  graph: LumenGraph,
  from: { conduitId: string; arc: number } | { atPort: PortId },
): PortId[] {
  if ('atPort' in from) return [from.atPort]
  const ends = graph.endpoints.get(from.conduitId)
  const out: PortId[] = []
  if (ends?.start !== undefined) out.push(ends.start)
  if (ends?.end !== undefined && ends.end !== ends.start) out.push(ends.end)
  return out
}

function arcAtPort(g: ConduitGeometry, arc: number): PortId | null {
  const nearEnd = g.total - arc
  const ends = { start: g.conduit.startPort, end: g.conduit.endPort }
  if (arc <= 0.02 && ends.start !== undefined) return ends.start
  if (nearEnd <= 0.02 && ends.end !== undefined) return ends.end
  return null
}

/**
 * Dijkstra over ports. Nodes are ports; an edge is a conduit, weighted by its arc
 * length, from the port at one end to the port at the other.
 *
 * A conduit with the same port at both ends is an edge from that port to itself,
 * which contributes nothing to a shortest path — and correctly so, because the
 * only way to benefit from the under-floor loop is to *enter* it, not to route
 * through it. Traversal of a loop is handled by the agent's own arc motion, which
 * is where the loop-closure behaviour actually lives.
 */
function dijkstra(
  graph: LumenGraph,
  from: PortId,
  target: ConduitGeometry,
  toArc: number,
): { steps: LumenPathStep[]; length: number; irreversible: boolean } | null {
  const goalPorts: PortId[] = []
  if (target.conduit.startPort !== undefined) goalPorts.push(target.conduit.startPort)
  if (target.conduit.endPort !== undefined && target.conduit.endPort !== target.conduit.startPort) {
    goalPorts.push(target.conduit.endPort)
  }
  if (goalPorts.length === 0) return null

  const dist = new Map<PortId, number>()
  const prev = new Map<PortId, PortId>()
  const visited = new Set<PortId>()
  dist.set(from, 0)

  for (;;) {
    let current: PortId | null = null
    let best = Number.POSITIVE_INFINITY
    for (const [p, d] of dist) {
      if (visited.has(p)) continue
      if (d < best) {
        best = d
        current = p
      }
    }
    if (current === null) break
    visited.add(current)

    for (const entry of graph.fromPort.get(current) ?? []) {
      const g = graph.conduits.get(entry.conduitId)
      if (g === undefined) continue
      const other = entry.atEnd === 'start' ? g.conduit.endPort : g.conduit.startPort
      if (other === undefined || other === current) continue
      const next = best + g.total
      const known = dist.get(other)
      if (known === undefined || next < known) {
        dist.set(other, next)
        prev.set(other, current)
      }
    }
  }

  let goal: PortId | null = null
  for (const p of goalPorts) {
    if (dist.has(p) && (goal === null || dist.get(p)! < dist.get(goal)!)) goal = p
  }
  if (goal === null) return null

  // Walk the port chain back, then convert to conduit steps.
  const chain: PortId[] = [goal]
  let cursor = goal
  while (cursor !== from) {
    const p = prev.get(cursor)
    if (p === undefined) return null
    chain.unshift(p)
    cursor = p
  }

  const steps: LumenPathStep[] = []
  let length = 0
  let irreversible = false

  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1]!
    const b = chain[i]!
    for (const entry of graph.fromPort.get(a) ?? []) {
      const g = graph.conduits.get(entry.conduitId)
      if (g === undefined) continue
      if (entry.atEnd === 'start' && g.conduit.endPort === b) {
        length += g.total
        if (isIrreversible(g)) irreversible = true
        steps.push({ conduitId: entry.conduitId, fromArc: 0, toArc: g.total, exitsAtPort: b })
      } else if (entry.atEnd === 'end' && g.conduit.startPort === b) {
        length += g.total
        if (isIrreversible(g)) irreversible = true
        steps.push({ conduitId: entry.conduitId, fromArc: g.total, toArc: 0, exitsAtPort: b })
      }
    }
  }

  // Finally, enter the target conduit and walk to the requested arc.
  const enteredAtStart = target.conduit.startPort === goal
  const entryArc = enteredAtStart ? 0 : target.total
  length += abs(toArc - entryArc)
  if (isIrreversible(target)) irreversible = true
  steps.push({
    conduitId: target.conduit.id,
    fromArc: entryArc,
    toArc,
    exitsAtPort: arcAtPort(target, toArc),
  })

  return { steps, length, irreversible }
}

function abs(v: number): number {
  return v < 0 ? -v : v
}