/**
 * What the run found, and what stopped it finding the rest.
 *
 * ## Why the classification exists
 *
 * A miss with a reason is a finding. A miss without one is a defect. And the
 * distinction that matters commercially is not "found" versus "not found" — it is:
 *
 * - **ARCHITECTURE** — the boat stopped the swarm. The space is unreachable by
 *   anything in the swarm, and the aperture that decides it is a fact about the
 *   vessel. *This is the product.* A surveyor has the same problem and solves it
 *   with a person and a torch.
 * - **DETECTION** — the swarm was there and the detector did not match it. That is
 *   a detector limitation, and reporting it as a coverage failure would be a lie.
 *
 * ## How it is measured
 *
 * From the run's own candidates, not from the agents' final poses. An agent's final
 * pose is where it stopped, not where it worked: the ground bot covered 98.9% of the
 * engine room and finished in a corner, so measuring a fault against that corner
 * would call a fault four metres away unreachable when the swarm had been right past
 * it. The candidates are the record of where the swarm actually detected something.
 */

import type { Finding } from './report.ts'
import type { AnomalySet } from '../world/anomalies.ts'
import { hypot2 } from '../math.ts'

export type MissKind = 'FOUND' | 'ARCHITECTURE' | 'DETECTION'

export type Verdict = {
  readonly id: string
  /** The cause, in the domain's vocabulary. */
  readonly cls: string
  /** The physical reading the detector would produce for it. */
  readonly signature: string
  readonly manifold: string
  readonly severity: number
  readonly found: boolean
  readonly kind: MissKind
  /** The measured detail: how far the nearest candidate was, and who was on the manifold. */
  readonly detail: string
  /** The authored reason, when there is one. */
  readonly reason?: string
  /** How far the matching finding was from the fault, metres. Null when unmatched. */
  readonly localisationError: number | null
}

/** How near a candidate has to be for the swarm to count as having been there. */
export const NEAR_CANDIDATE_M = 1.0

export function buildVerdict(
  findings: readonly Finding[],
  truth: AnomalySet,
  manifoldAgents: ReadonlyMap<string, readonly string[]>,
): Verdict[] {
  const out: Verdict[] = []
  for (const a of truth.anomalies) {
    const reason = (a as unknown as { missReason?: string }).missReason

    // The matched finding, if the report matched one.
    const matched = findings.find((f) => f.matchedAnomalyId === a.id)

    // The nearest finding of any kind — the record of where the swarm was.
    //
    // Findings, not raw candidates: the findings are the associated candidates,
    // which is what the report carries, and a diagnostic that measures the
    // nearest over a different set than the report does will disagree with the
    // report it is supposed to be checking.
    let nearest = Number.POSITIVE_INFINITY
    let nearestId = '—'
    for (const f of findings) {
      const d = hypot2(f.x - a.position[0], f.z - a.position[2])
      if (d < nearest) {
        nearest = d
        nearestId = f.detectorId
      }
    }

    const agents = manifoldAgents.get(a.manifold) ?? []
    // "at Infinity metres" is not a measurement. When nothing was raised on this
    // manifold at all, say so.
    const nearestText =
      Number.isFinite(nearest) ? `nearest candidate ${nearestId} at ${nearest.toFixed(2)} m` : 'no candidate was raised'
    const detail =
      agents.length === 0
        ? 'no agent in the swarm lives on this manifold'
        : `agents on this manifold: ${agents.join(', ')}; ${nearestText}`

    const kind: MissKind =
      matched !== undefined ? 'FOUND' : nearest <= NEAR_CANDIDATE_M ? 'DETECTION' : 'ARCHITECTURE'

    out.push({
      id: a.id,
      cls: a.class,
      signature: a.signature,
      manifold: a.manifold,
      severity: a.severity,
      found: matched !== undefined,
      kind,
      detail,
      reason,
      localisationError: matched?.localisationError ?? null,
    })
  }
  return out
}
