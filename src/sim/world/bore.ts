/**
 * The bore scan. What a crawler with `sense.depth` can actually measure.
 *
 * ## Why this is not `scanDepth`
 *
 * `scanDepth` casts rays through a 2-D occupancy grid. Inside a 40 mm pipe there is
 * no floor, no grid, and no lateral freedom: the agent has one degree of freedom
 * (arc length) and one direction it can look. So the "scan" is a single forward
 * range, and pretending otherwise would mean modelling a bore as a corridor — which
 * is how a simulator ends up claiming a crawl was mapped.
 *
 * ## What it returns
 *
 * The distance to the first obstruction ahead, capped at the sensor's range. It
 * deliberately reports *nothing* about what the obstruction is: the crawler has
 * neither a thermal nor an air sensor (spec §3.2), so it cannot tell root intrusion
 * from a collapsed joint from a bag of rubble. That ignorance is the entire reason
 * §6.4's handoff mechanism has to exist, so it is modelled rather than papered over.
 *
 * ## Where the geometry comes from
 *
 * From the oracle, via `buildConduitObstructions`. That is not a leak — it is the
 * same relationship `buildFields` has to the oracle. The oracle defines the world;
 * sensors read geometry; detectors read sensor output. A detector reading the
 * oracle directly would be the leak, and `test/boundary/no-ground-truth-leak.test.ts`
 * is what holds that line.
 */

import type { AnomalySet } from './anomalies.ts'
import type { ConduitGeometry } from './lumen.ts'

/** One obstruction inside a conduit, in the form a sensor can range to. */
export type BoreObstruction = {
  readonly arc: number
  readonly anomalyId: string
}

/**
 * Obstructions per conduit, from the oracle.
 *
 * Only anomalies that name a conduit become geometry. A constrained defect with no
 * conduit target is one nothing can reach or see — `bv-02` and `bv-03` are authored
 * that way, and they will score zero recall for the same reason `structural_crack`
 * does: not because the detector is weak, but because no agent can get there. That is
 * reported, not tuned away.
 */
export function buildConduitObstructions(
  truth: AnomalySet,
): Map<string, BoreObstruction[]> {
  const out = new Map<string, BoreObstruction[]>()
  for (const a of truth.anomalies) {
    if (a.conduit === undefined) continue
    const list = out.get(a.conduit.conduitId) ?? []
    list.push({ arc: a.conduit.arc, anomalyId: a.id })
    out.set(a.conduit.conduitId, list)
  }
  // Ascending arc, so `scanBore`'s "first obstruction ahead" is a scan and not a
  // search — and so the result does not depend on authoring order.
  for (const list of out.values()) list.sort((x, y) => x.arc - y.arc)
  return out
}

export type BoreScan = {
  /** Distance to the nearest obstruction ahead, metres. Capped at maxRange. */
  readonly range: number
  /** True when the reading was cut short by something rather than by sensor range. */
  readonly obstructed: boolean
  /** Distance to the conduit's end ahead, metres. */
  readonly toEnd: number
}

/**
 * Cast the crawler's forward depth ray.
 *
 * `maxRange` is the sensor's limit. The scan returns the smaller of that and the
 * distance to the next obstruction — or to the end of the conduit, which a crawler
 * cannot distinguish from an obstruction by range alone and therefore must not
 * report as one.
 */
export function scanBore(
  geo: ConduitGeometry,
  obstructions: readonly BoreObstruction[],
  arc: number,
  direction: 1 | -1,
  maxRange: number,
  noise: number,
): BoreScan {
  const remaining = direction === 1 ? geo.total - arc : arc
  const toEnd = remaining < 0 ? 0 : remaining

  let range = maxRange

  for (const o of obstructions) {
    const ahead = direction === 1 ? o.arc - arc : arc - o.arc
    // Strictly ahead, and within sensor range. An obstruction the agent is level
    // with is not "ahead" — it would be sensed at range 0, which is indistinguishable
    // from being inside something.
    if (ahead <= 0 || ahead >= range) continue
    range = ahead
  }

  if (toEnd < range) range = toEnd
  if (range < 0) range = 0
  if (noise !== 0) range += noise

  return {
    range,
    // "Obstructed" means: something inside the bore stopped the ray short of both
    // the sensor's limit and the pipe's end. Anything looser reports the end of a
    // duct as a defect, and the crawler would hand off every time it finished a run.
    obstructed: range < toEnd - BORE_END_MARGIN && range < maxRange - BORE_END_MARGIN,
    toEnd,
  }
}

/**
 * Slack for distinguishing the end of a bore from an obstruction inside it, metres.
 *
 * Larger than the range noise, or a noisy reading at the far end of a pipe would be
 * reported as a blockage. This is the same class of decision as the wall-surface
 * magnitude gate that silenced a detector for a whole stage: a threshold has to sit
 * outside the noise it is meant to survive.
 */
export const BORE_END_MARGIN = 0.06