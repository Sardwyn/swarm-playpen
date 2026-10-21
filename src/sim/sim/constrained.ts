/**
 * The constrained-manifold detector, and the handoff it forces.
 *
 * ## The whole file exists because of one missing capability
 *
 * Spec §3.2 gives the inchworm `sense.depth` and nothing else: no thermal, no air,
 * no bearing outside its own bore. So the only thing it can do is notice that
 * something is *in the way* — and it cannot tell what. Every finding it produces is
 * therefore a **suspicion**, published below `CONFIDENCE_MIN` by construction,
 * because a sensor that measured only a range has no business asserting a class.
 *
 * That is not a limitation to engineer around. It is the reason spec §6.4's
 * escalation mechanism has to exist at all, and the reason handoff is about
 * *capability* rather than about distance. A crawler that could confirm its own
 * findings would make the port graph decorative.
 *
 * ## The handoff
 *
 * A suspicion cannot be actioned where it was found — nothing with `sense.thermal`
 * can reach 8 m into a 70 mm pipe. So it is escalated to the **nearest port the
 * crawler can reach**, as a `verify_thermal` job on the ground manifold. The ground
 * bot drives to that port and samples the air and the wall around the penetration.
 *
 * That corroboration is genuinely weaker than looking inside the pipe, and the
 * confirmation rate is reported as a number rather than assumed. If most handoffs
 * come back unconfirmed, that is a finding about how much of the constrained manifold
 * is inspectable from outside — not a defect to tune the threshold against.
 */

import type { AgentState, AgentId, JobId } from '../types.ts'
import { CONDUIT_SUSPICION_CONFIDENCE } from '../types.ts'
import { clamp } from '../math.ts'
import type { BoreObstruction } from '../world/bore.ts'
import { scanBore, BORE_END_MARGIN } from '../world/bore.ts'
import type { ConduitGeometry } from '../world/lumen.ts'
import { positionAt } from '../world/lumen.ts'

export type ConstrainedDetectorState = {
  /** `conduitId:arc` for obstructions already reported, so one blockage is one finding. */
  readonly raised: Set<string>
  nextId: number
}

export function createConstrainedDetectorState(): ConstrainedDetectorState {
  return { raised: new Set(), nextId: 1 }
}

/**
 * How close to a blockage the crawler must be before it calls it.
 *
 * The detector fires when the forward range is cut short by more than
 * `BORE_END_MARGIN`, so the sensing happens at run time; this is only the clearance
 * at which it stops reporting, which keeps two or three readings of the same
 * blockage from becoming three findings.
 *
 * A tolerance rather than a single reading is not softening — it is what "an
 * obstruction" means when the only instrument is a range finder bouncing off it.
 */
export const OBSTRUCTION_CLEARANCE = 0.35

export type ObstructionCandidate = {
  readonly id: string
  readonly agentId: AgentId
  readonly tick: number
  readonly conduitId: string
  readonly arc: number
  readonly x: number
  readonly y: number
  readonly z: number
  /** Always `CONDUIT_SUSPICION_CONFIDENCE` — the crawler has no way to earn more. */
  readonly confidence: number
}

/**
 * Scan the bore ahead and report a blockage if there is one.
 *
 * Returns nothing most of the time, which is correct: a healthy pipe is most of what
 * a pipe is. The reporting side is deliberately narrow so that a silent detector is
 * distinguishable from a detector that is not running — `no-ground-truth-leak` and
 * `no-silent-detector` both depend on the distinction, and the constrained manifold
 * gets a scenario test for it too.
 */
export function detectBoreObstruction(
  agentId: AgentId,
  tick: number,
  state: ConstrainedDetectorState,
  geo: ConduitGeometry,
  obstructions: readonly BoreObstruction[],
  arc: number,
  direction: 1 | -1,
  maxRange: number,
  noise: number,
): ObstructionCandidate | null {
  const scan = scanBore(geo, obstructions, arc, direction, maxRange, noise)
  if (!scan.obstructed) return null

  // Which blockage, if any, is close enough to call?
  let target: BoreObstruction | null = null
  let bestDistance = OBSTRUCTION_CLEARANCE
  for (const o of obstructions) {
    const d = direction === 1 ? o.arc - arc : arc - o.arc
    if (d < 0 || d > bestDistance) continue
    bestDistance = d
    target = o
  }
  if (target === null) return null

  const key = `${geo.conduit.id}:${target.arc.toFixed(3)}`
  if (state.raised.has(key)) return null
  state.raised.add(key)

  const at = positionAt(geo, target.arc)
  return {
    id: `cand-c-${state.nextId++}`,
    agentId,
    tick,
    conduitId: geo.conduit.id,
    arc: target.arc,
    x: at[0],
    y: at[1],
    z: at[2],
    confidence: CONDUIT_SUSPICION_CONFIDENCE,
  }
}

/**
 * Nearest port the crawler can reach from a conduit, for the handoff to sit at.
 *
 * `null` when the conduit opens onto no port at all, which is the honest answer for
 * a dead end with no entry — and the reason the 40 mm waste run's *entry* port is
 * what a handoff anchors to rather than anything near the defect.
 */
export function handoffPortFor(
  endpoints: ReadonlyMap<string, { start?: string; end?: string }>,
  conduitId: string,
  worldPositions: ReadonlyMap<string, [number, number, number]>,
): { portId: string; position: [number, number, number] } | null {
  const ends = endpoints.get(conduitId)
  if (ends === undefined) return null
  const candidates = [ends.start, ends.end].filter((p): p is string => p !== undefined)
  for (const portId of candidates) {
    const p = worldPositions.get(portId)
    if (p !== undefined) return { portId, position: p }
  }
  return null
}

export { CONDUIT_SUSPICION_CONFIDENCE, BORE_END_MARGIN }
export type { JobId, AgentState }
export { clamp }