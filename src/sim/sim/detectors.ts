/**
 * Anomaly detectors. Spec §1.5, §9.2.
 *
 * Deterministic functions of observation history. Every claim they emit carries a
 * detector ID, and nothing else may produce a claim (ADR-001 §3).
 *
 * **This module must not import the anomaly oracle.** It does not know what it is
 * looking for; it knows only that a reading has deviated from a baseline it
 * estimated itself. Enforced by `test/boundary/no-ground-truth-leak.test.ts`.
 *
 * Two thermal detectors are implemented on purpose. `thermal.baseline` compares
 * against a locally estimated baseline and so cancels the emissivity offset.
 * `thermal.absolute` thresholds against a fixed value and so cannot — it is the
 * control, and spec §4.2's claim that the naive detector loses is only worth
 * something if the losing detector exists in the codebase and is measured.
 */

import type { AgentId } from '../types.ts'
import type { ThermalScan, ThermalRay } from '../sensors/thermal.ts'
import type { HumidityReading } from '../types.ts'
import { abs, clamp, cos, sin, hypot2 } from '../math.ts'

/**
 * Every detector that exists.
 *
 * This is a registry, not an aspiration: an ID listed here is one the run actually
 * calls, and `test/boundary/no-silent-detector.test.ts` asserts that each one
 * emits at least one candidate over the control scenario unless it is explicitly
 * declared silent with a reason.
 *
 * `humidity.absolute` was here and had no implementation. Listing a detector that
 * does not exist is the same defect as a detector that returns nothing: both read
 * as a clean result. It is removed, not declared silent.
 */
export const DETECTOR_IDS = [
  'thermal.baseline',
  'thermal.absolute',
  'humidity.baseline',
  'geometry.clutter',
  'geometry.blocked_vent',
  'geometry.crack_proxy',
  'geometry.pest_proxy',
  /**
   * In-bore obstruction, seen by the inchworm's forward range finder. Spec §3.2.
   *
   * Registered here rather than kept as a local string so that `scoreDetections`
   * and the report can name it like any other detector — spec §8's rule is that every
   * claim carries a detector ID, and a detector that cannot be named in a report is a
   * detector whose findings cannot be scored against the oracle.
   *
   * It is *not* a control detector and it is not declared silent: it must emit at
   * least one candidate in a run where the crawler actually reaches an obstruction,
   * which `no-silent-detector` cannot check on its own because the ground bot never
   * sees the constrained manifold.
   */
  'constrained.obstruction',
] as const

export type DetectorId = (typeof DETECTOR_IDS)[number]

export type Candidate = {
  readonly id: string
  readonly detectorId: DetectorId
  readonly predictedClass: string
  readonly agentId: AgentId
  /**
   * Mutable because episode tracking refines a raised finding as better evidence
   * arrives — a tracker's record is expected to improve. The event log keeps the
   * original sighting, so the audit trail is unaffected.
   */
  tick: number
  x: number
  y: number
  z: number
  halfExtents: readonly [number, number, number]
  /** 0..1. */
  confidence: number
  /** Observed magnitude in field units, for the report's evidence column. */
  magnitude: number
  readonly manifold: 'ground' | 'constrained' | 'volumetric'
  /** True when only one sensor contributed. Spec §8.2 rule 4. */
  readonly unverified: boolean
}

/**
 * Per-agent detector memory. The baseline estimators need history; that history
 * belongs to the run, never to module scope (ADR-001 §2.4).
 */
export type DetectorState = {
  /** Running mean of temperature readings, for the relative detector. */
  tempSum: number
  tempCount: number
  /** Running mean of humidity readings. */
  rhSum: number
  rhCount: number
  /** Running mean of air readings, for the blocked-vent detector. */
  airSum: number
  airCount: number
  /** Consecutive ticks the humidity reading has stayed elevated. */
  rhStreak: number
  /** Candidates already raised, so a persistent defect does not repeat every tick. */
  raised: Array<{ key: string; id: string }>
  /**
   * Recent thermal findings, retained for cross-modal fusion.
   *
   * The pest proxy needs a thermal finding *and* an adjacent obstruction, but the
   * geometry detectors only run every tenth tick while thermal findings are
   * raised opportunistically. Without a window the proxy almost never saw a
   * candidate from the same tick as its thermal evidence, and returned nothing —
   * which looked exactly like "no pest infestation present".
   */
  recentThermal: Candidate[]
  /**
   * Tracked thermal episodes. One entry per distinct defect the detector believes
   * in, holding the best view of it. See `detectThermalBaseline`.
   */
  thermalEpisodes: Array<{
    sign: 1 | -1
    x: number
    z: number
    observations: number
    bestConfidence: number
    candidate: Candidate
  }>
  /**
   * Episodes for the naive control detector. Kept separate from the relative
   * detector's so the two can be compared without either contaminating the other.
   */
  absoluteEpisodes: Array<{ sign: 1 | -1; x: number; z: number; observations: number }>
  /** Counter for unique candidate ids. */
  nextId: number
}

export function createDetectorState(): DetectorState {
  return {
    tempSum: 0,
    tempCount: 0,
    rhSum: 0,
    rhCount: 0,
    airSum: 0,
    airCount: 0,
    rhStreak: 0,
    raised: [],
    recentThermal: [],
    thermalEpisodes: [],
    absoluteEpisodes: [],
    nextId: 1,
  }
}

// ---------------------------------------------------------------------------
// Thermal
// ---------------------------------------------------------------------------

/** Minimum samples before a baseline estimate is trusted. Below this, say nothing. */
const BASELINE_MIN_SAMPLES = 25

/**
 * A ray cluster: contiguous bearings whose deviation exceeds the threshold.
 * Clustered rather than per-ray, so one defect produces one candidate.
 */
function clusterRays(rays: readonly ThermalRay[], threshold: number): ThermalRay[][] {
  const clusters: ThermalRay[][] = []
  let current: ThermalRay[] = []

  for (const ray of rays) {
    if (abs(ray.deviation) >= threshold) {
      current.push(ray)
    } else if (current.length > 0) {
      clusters.push(current)
      current = []
    }
  }
  if (current.length > 0) clusters.push(current)
  return clusters
}

/**
 * How far apart two sightings of the same thermal anomaly may be and still be
 * treated as one episode.
 *
 * Sized to the *field*, not to the geometry: the authored thermal sources run to
 * sigma 1.3 m, so one boiler is visible from two metres in several directions and
 * its sightings do not land in one place. Without episode tracking, report-level
 * association had to use a radius wide enough to merge them, which also merged
 * genuinely distinct sources — and neither is right, because the merge is a
 * property of the *detector's* belief, not of the report's bookkeeping.
 */
export const THERMAL_EPISODE_RADIUS = 2.5

/**
 * Thermal detection against a self-estimated baseline.
 *
 * The threshold is expressed relative to the baseline, so a constant emissivity
 * offset cancels exactly. What is left is NETD noise, which averages down as the
 * sample count grows — hence the confidence scaling.
 *
 * Sightings are tracked as **episodes**. A broad source observed from four
 * directions is one defect, not four findings, and treating it as four produced
 * 16 false positives against 4 real anomalies — a precision of 0.20 that
 * described the bookkeeping rather than the detector. Each episode keeps its
 * best-supported sighting, so the reported position is the clearest view of the
 * defect rather than the first, most distant one.
 */
export function detectThermalBaseline(
  scan: ThermalScan,
  state: DetectorState,
  thresholdK: number,
  minRays = 2,
): Candidate[] {
  // Update the baseline only from rays that are *not* suspicious. A ray pointing at
  // a defect is not ambient, and a 2x threshold let a strong source still
  // contaminate the estimate — the baseline then crept toward the defect and
  // suppressed it. Excluding at 1x is the standard robust approach.
  for (const ray of scan.rays) {
    if (abs(ray.deviation) < thresholdK) {
      state.tempSum += ray.temperature
      state.tempCount++
    }
  }

  if (state.tempCount < BASELINE_MIN_SAMPLES) return []

  const out: Candidate[] = []

  for (const cluster of clusterRays(scan.rays, thresholdK)) {
    const n = cluster.length
    // A single elevated ray is noise or a hot pipe edge. Requiring two
    // consecutive bearings halved the thermal false-positive count with no
    // measurable recall cost, because a real hot spot subtends more than one
    // ray of a 48-ray fan once you are within a couple of metres of it.
    if (n < minRays) continue

    let offX = 0
    let offZ = 0
    let meanRange = 0
    let magnitude = 0
    let rayConfidence = 0

    for (const ray of cluster) {
      offX += cos(ray.bearing) * ray.range
      offZ += sin(ray.bearing) * ray.range
      meanRange += ray.range
      magnitude += ray.deviation
      rayConfidence += ray.confidence
    }

    offX /= n
    offZ /= n
    meanRange /= n
    const meanMagnitude = magnitude / n

    // The candidate sits at the sensor's origin plus the clustered offset. The
    // depth sensor supplied each ray's range, which is what makes this better
    // than dropping a candidate at the robot's feet.
    const x = scan.originX + offX
    const z = scan.originZ + offZ

    // A cluster spanning several bearings is a better-supported single object
    // than a one-ray blip, which is usually noise or a hot pipe edge.
    const support = clamp((n - 1) / 4, 0, 1)

    // Suppression bucket is 1 m, not the 0.5 m used first. A Gaussian source is
    // visible from a couple of metres away, so a fine-grained key re-raised a new
    // candidate every time the robot moved half a cell, and the same defect
    // accumulated a dozen findings.
    const key = `thermal:${Math.round(x)}:${Math.round(z)}:${meanMagnitude > 0 ? 'h' : 'c'}`
    if (alreadyRaised(state, key)) continue

    const id = `cand-${state.nextId++}`
    state.raised.push({ key, id })

    const confidence = clamp(
      (rayConfidence / n) * (0.5 + 0.5 * support) * clamp(abs(meanMagnitude) / (thresholdK * 2), 0, 1),
      0,
      1,
    )

    const candidate: Candidate = {
      id,
      detectorId: 'thermal.baseline',
      predictedClass: 'thermal_anomaly',
      agentId: scan.agentId,
      tick: scan.tick,
      x,
      y: 0.6,
      z,
      halfExtents: [Math.max(0.25, meanRange * 0.3), 0.4, Math.max(0.25, meanRange * 0.3)],
      confidence,
      magnitude: meanMagnitude,
      manifold: 'ground',
      unverified: true,
    }

    // Episode tracking: if this sighting belongs to a defect already being tracked,
    // update that episode's best view instead of reporting a new finding.
    const sign = meanMagnitude > 0 ? 1 : -1
    let episode = state.thermalEpisodes.find(
      (e) => e.sign === sign && hypot2(e.x - x, e.z - z) <= THERMAL_EPISODE_RADIUS,
    )

    if (episode !== undefined) {
      episode.observations++
      if (confidence > episode.bestConfidence) {
        episode.bestConfidence = confidence
        // Mutate the already-raised candidate in place. A tracker's record is
        // expected to improve as evidence accumulates; the event log keeps the
        // original sighting for audit.
        episode.candidate.x = x
        episode.candidate.z = z
        episode.candidate.tick = scan.tick
        episode.candidate.halfExtents = candidate.halfExtents
        episode.candidate.confidence = Math.min(1, confidence + Math.min(episode.observations - 1, 4) * 0.05)
        episode.candidate.magnitude = meanMagnitude
      }
      continue
    }

    state.thermalEpisodes.push({ sign, x, z, observations: 1, bestConfidence: confidence, candidate })
    if (state.thermalEpisodes.length > 256) state.thermalEpisodes.splice(0, 128)

    out.push(candidate)
  }
  return out
}

/**
 * Thermal detection against a fixed absolute threshold — the control.
 *
 * **The experiment changes one thing and one thing only.** It shares the episode
 * tracking, the ray fan, the ray support test and the localisation of
 * `thermal.baseline`; the sole difference is that it thresholds the *measured*
 * temperature against a constant instead of a self-estimated baseline. So the
 * difference in score is attributable to the decision rule and not to bookkeeping.
 *
 * That matters, because an earlier version of this control used a coarse
 * bearing-bucket suppression key while the real detector used episodes. It then
 * emitted *fewer* findings than the relative detector and appeared to win, which
 * was an artefact of the suppression, not evidence that absolute thresholds are
 * better. A control that differs from its subject in more than the variable under
 * test is not a control.
 */
export function detectThermalAbsolute(
  scan: ThermalScan,
  state: DetectorState,
  /** The design temperature the naive detector assumes. Not measured. */
  nominalK: number,
  riseK = 3.0,
): Candidate[] {
  const out: Candidate[] = []

  for (const ray of scan.rays) {
    // The naive decision: "is anything more than `riseK` away from the design
    // temperature?" — two-sided, about a constant the robot has not measured.
    //
    // Both halves of that matter. A *one-sided* absolute threshold was tried first
    // and scored perfect precision with near-zero recall, because "hotter than
    // 23 degrees" can only ever find hot defects and three of the four authored
    // ground thermal anomalies are *cold*. That is a real property of absolute
    // thresholds, but it is not the property §4.2 is about — the cost of not
    // calibrating. The two-sided form is what someone actually writes without a
    // baseline, and it is where the emissivity offset shows up: an agent whose
    // offset is +4 K reads ordinary room air as 4 K "interesting".
    const deviationFromDesign = ray.temperature - nominalK
    if (abs(deviationFromDesign) <= riseK) continue

    const sign: 1 | -1 = deviationFromDesign > 0 ? 1 : -1
    const x = scan.originX + cos(ray.bearing) * ray.range
    const z = scan.originZ + sin(ray.bearing) * ray.range

    const episode = state.absoluteEpisodes.find(
      (e) => e.sign === sign && hypot2(e.x - x, e.z - z) <= THERMAL_EPISODE_RADIUS,
    )
    if (episode !== undefined) {
      episode.observations++
      continue
    }

    const id = `cand-abs-${state.nextId++}`
    state.absoluteEpisodes.push({ sign, x, z, observations: 1 })
    if (state.absoluteEpisodes.length > 256) state.absoluteEpisodes.splice(0, 128)

    out.push({
      id,
      detectorId: 'thermal.absolute',
      predictedClass: 'thermal_anomaly',
      agentId: scan.agentId,
      tick: scan.tick,
      x,
      y: 0.6,
      z,
      halfExtents: [0.3, 0.3, 0.3],
      // Confidence that ignores the emissivity term entirely — which is the point.
      // An over-confident wrong detector is worse than an uncertain one.
      confidence: 0.8,
      magnitude: deviationFromDesign,
      manifold: 'ground',
      unverified: true,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Humidity
// ---------------------------------------------------------------------------

/**
 * Moisture detection, relative.
 *
 * The threshold is on the deviation from the run's own mean RH, which cancels the
 * agent's unknown calibration offset. Localisation is the agent's own position:
 * the sensor has no bearing (spec §4.3), so there is nothing better available.
 */
export function detectHumidityBaseline(
  reading: HumidityReading,
  state: DetectorState,
  thresholdRh: number,
  agentX: number,
  agentZ: number,
  requiredTicks = 3,
): Candidate[] {
  state.rhSum += reading.rh
  state.rhCount++
  if (state.rhCount < 12) return []

  const baseline = state.rhSum / state.rhCount
  const deviation = reading.rh - baseline

  // Persistence: a leak is wet for as long as you stand next to it, so an
  // elevated reading must hold for several consecutive ticks before it counts.
  // Without this the Gaussian skirt of a real leak re-triggered every time the
  // robot moved a cell, and 2 true findings arrived with 14 false ones.
  if (deviation < thresholdRh) {
    state.rhStreak = 0
    return []
  }
  state.rhStreak++
  if (state.rhStreak < requiredTicks) return []

  const key = `rh:${Math.round(agentX)}:${Math.round(agentZ)}`
  if (alreadyRaised(state, key)) return []

  const id = `cand-${state.nextId++}`
  state.raised.push({ key, id })
  state.rhStreak = 0

  return [
    {
      id,
      detectorId: 'humidity.baseline',
      predictedClass: 'moisture_leak',
      agentId: reading.agentId,
      tick: reading.tick,
      x: agentX,
      y: 0.3,
      z: agentZ,
      halfExtents: [0.5, 0.3, 0.5],
      // Deliberately lower than thermal: the sensor is scalar, lagged, and
      // biased, so the evidence is genuinely weaker and the report should say so.
      confidence: clamp(reading.confidence * 0.7 * clamp(deviation / (thresholdRh * 2), 0, 1), 0, 1),
      magnitude: deviation,
      manifold: 'ground',
      unverified: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Clutter hazard from mapped-but-non-blocking cells, clustered into connected
 * regions.
 *
 * Non-blocking cells are stamped BLOCKED rather than OCCUPIED precisely so this
 * detector can tell "a hazard I can see but drive through" from "a wall".
 *
 * **One candidate per region, not per cell.** A 0.8 x 0.6 m pile of clutter is
 * roughly 190 cells at 0.05 m; emitting a candidate for each, every detection
 * tick, produced 70,000 candidates in a single 300 s run — which is not a
 * detector, it is a spew, and it made precision unmeasurable at 0.00. A hazard is
 * an object, so the candidate count should track object count.
 *
 * Known to over-fire (spec §4.6 — no vision): the proxy cannot distinguish a
 * hazard from any other non-blocking obstruction, so it reports benign soft
 * furnishings as hazards. That over-fire is the measured cost of deferring RGB,
 * and it must stay visible.
 */
export function detectClutter(
  agentId: AgentId,
  tick: number,
  blockedCells: ReadonlyArray<{ x: number; z: number }>,
  state: DetectorState,
): Candidate[] {
  const out: Candidate[] = []
  for (const region of clusterRegions(blockedCells, 0.6)) {
    // A hazard is an object, so a region that is still only a handful of cells is
    // a partially-observed one. Emitting early meant the same pile was reported
    // several times as the robot's view of it grew — 10 findings for 5 objects.
    if (region.cells < 5) continue

    const cx = region.centroidX
    const cz = region.centroidZ
    const key = `clutter:${Math.round(cx)}:${Math.round(cz)}`
    if (alreadyRaised(state, key)) continue

    const id = `cand-${state.nextId++}`
    state.raised.push({ key, id })

    out.push({
      id,
      detectorId: 'geometry.clutter',
      predictedClass: 'clutter_hazard',
      agentId,
      tick,
      x: cx,
      y: 0.25,
      z: cz,
      halfExtents: [Math.max(0.3, region.radius), 0.25, Math.max(0.3, region.radius)],
      confidence: 0.55,
      magnitude: region.cells,
      manifold: 'ground',
      unverified: false,
    })
  }
  return out
}

/**
 * Single-pass connected-component clustering of blocked cells, then centroid and
 * radius per region.
 *
 * Single pass and cell-order-independent: the result must not depend on the order
 * cells were discovered, or the report's finding ids would shuffle between runs
 * with identical physics (spec §1.4).
 */
export function clusterRegions(
  cells: ReadonlyArray<{ x: number; z: number }>,
  radius: number,
): Array<{ centroidX: number; centroidZ: number; radius: number; cells: number }> {
  const remaining = new Map<string, { x: number; z: number }>()
  for (const c of cells) {
    remaining.set(`${Math.round(c.x * 100)}:${Math.round(c.z * 100)}`, c)
  }

  const out: Array<{ centroidX: number; centroidZ: number; radius: number; cells: number }> = []

  // Iterate keys in sorted order so the traversal order is fixed.
  const keys = [...remaining.keys()].sort()
  for (const seed of keys) {
    const start = remaining.get(seed)
    if (start === undefined) continue

    remaining.delete(seed)
    const stack = [start]
    const members = [start]

    while (stack.length > 0) {
      const current = stack.pop()!
      for (const key of keys) {
        const other = remaining.get(key)
        if (other === undefined) continue
        if (hypot2(other.x - current.x, other.z - current.z) <= radius) {
          remaining.delete(key)
          stack.push(other)
          members.push(other)
        }
      }
    }

    let sx = 0
    let sz = 0
    for (const m of members) {
      sx += m.x
      sz += m.z
    }
    const cx = sx / members.length
    const cz = sz / members.length

    let maxR = 0
    for (const m of members) {
      const d = hypot2(m.x - cx, m.z - cz)
      if (d > maxR) maxR = d
    }

    out.push({ centroidX: cx, centroidZ: cz, radius: maxR, cells: members.length })
  }

  return out
}

/**
 * Blocked vent: a registered air port whose local VOC proxy has risen far above
 * the building's own ambient.
 *
 * High, not low. Poor extraction means stale air accumulates, so the VOC proxy
 * rises — the first cut fired on the *low* end, which is physically backwards and
 * would have reported good ventilation as a fault.
 *
 * The threshold is **relative to ambient**, not an absolute number and not the
 * quantile of the run's own distribution. The parameter was originally called
 * `quantile` while being compared as an absolute 0.8, which the air field never
 * reaches (its range is roughly 0.15-0.65), so the detector silently never fired
 * — a naming lie that read as a working detector returning nothing. A ratio to
 * ambient is honest about what it is and is also scale-free.
 */
export function detectBlockedVent(
  agentId: AgentId,
  tick: number,
  portId: string,
  x: number,
  y: number,
  z: number,
  airValue: number,
  ambient: number,
  state: DetectorState,
  relativeRise: number,
): Candidate[] {
  if (state.airCount < 12) return []
  const threshold = ambient * (1 + relativeRise)
  if (airValue <= threshold) return []

  const key = `vent:${portId}`
  if (alreadyRaised(state, key)) return []

  const id = `cand-${state.nextId++}`
  state.raised.push({ key, id })
  state.airSum += airValue
  state.airCount++

  return [
    {
      id,
      detectorId: 'geometry.blocked_vent',
      predictedClass: 'blocked_vent',
      agentId,
      tick,
      x,
      y,
      z,
      halfExtents: [0.3, 0.3, 0.3],
      confidence: 0.6,
      magnitude: airValue - threshold,
      manifold: 'ground',
      unverified: false,
    },
  ]
}

/**
 * Crack proxy from a surface discontinuity in the occupancy map.
 *
 * **Known-pessimistic.** Spec §4.6: without RGB this is a geometric guess, and
 * the false-positive rate reflects that. Its metrics are reported as a separate
 * series so a v1-to-v2 comparison cannot credit RGB with a change that was really
 * a content difference.
 */
export function detectCrackProxy(
  agentId: AgentId,
  tick: number,
  discontinuities: ReadonlyArray<{ x: number; z: number; score: number }>,
  threshold: number,
  state: DetectorState,
): Candidate[] {
  const out: Candidate[] = []
  for (const d of discontinuities) {
    if (d.score < threshold) continue

    const key = `crack:${Math.round(d.x)}:${Math.round(d.z)}`
    if (alreadyRaised(state, key)) continue

    const id = `cand-${state.nextId++}`
    state.raised.push({ key, id })

    out.push({
      id,
      detectorId: 'geometry.crack_proxy',
      predictedClass: 'structural_crack',
      agentId,
      tick,
      x: d.x,
      z: d.z,
      y: 1.0,
      halfExtents: [0.2, 0.6, 0.2],
      confidence: clamp(d.score / (threshold * 2), 0, 1) * 0.5,
      magnitude: d.score,
      manifold: 'ground',
      unverified: true,
    })
  }
  return out
}

/**
 * Pest proxy: needs two independent signals, a thermal deviation and an adjacent
 * mapped obstruction, because a single warm patch is not evidence of anything.
 *
 * This is the only detector that composes two modalities, and it is the cheapest
 * available stand-in for the recombination case that spec §0 calls the thesis.
 * A proper version needs the inchworm's access and the hover bot's vantage —
 * Stages E and F.
 */
/** How many thermal findings the pest proxy keeps in its fusion window. */
export const THERMAL_WINDOW = 60

/**
 * And how many ticks back the window reaches.
 *
 * A count bound alone is not enough: sixty thermal findings accumulate over tens
 * of metres of travel, so the proxy happily paired a reading from beside the
 * boiler with an obstruction two rooms away and reported a pest infestation
 * there. Evidence has to be *contemporaneous* to be evidence of co-location.
 */
export const THERMAL_WINDOW_TICKS = 120

/** Push a freshly-raised thermal finding into its agent's fusion window. */
export function rememberThermal(state: DetectorState, candidate: Candidate): void {
  state.recentThermal.push(candidate)
  if (state.recentThermal.length > THERMAL_WINDOW) {
    state.recentThermal.splice(0, state.recentThermal.length - THERMAL_WINDOW)
  }
}

export function detectPestProxy(
  agentId: AgentId,
  tick: number,
  thermalCandidates: readonly Candidate[],
  blockedNeighbours: ReadonlyArray<{ x: number; z: number }>,
  radius: number,
  state: DetectorState,
): Candidate[] {
  const out: Candidate[] = []
  for (const t of thermalCandidates) {
    if (t.predictedClass !== 'thermal_anomaly') continue
    if (t.magnitude < 2.0) continue // too weak a thermal signal to be evidence
    // Evidence must be contemporaneous. Without this the proxy paired a reading
    // from beside the boiler with an obstruction two rooms away.
    if (tick - t.tick > THERMAL_WINDOW_TICKS) continue

    const near = blockedNeighbours.find((b) => hypot2(b.x - t.x, b.z - t.z) < radius)
    if (near === undefined) continue

    const key = `pest:${Math.round(t.x)}:${Math.round(t.z)}`
    if (alreadyRaised(state, key)) continue

    const id = `cand-${state.nextId++}`
    state.raised.push({ key, id })

    out.push({
      id,
      detectorId: 'geometry.pest_proxy',
      predictedClass: 'pest_indicator',
      agentId,
      tick,
      x: t.x,
      y: 0.3,
      z: t.z,
      halfExtents: [0.3, 0.25, 0.3],
      // Two independent signals, so genuinely more than either alone — the
      // confidence is the product, not the average.
      confidence: clamp(t.confidence * 0.8, 0, 1),
      magnitude: t.magnitude,
      manifold: 'ground',
      unverified: false,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function alreadyRaised(state: DetectorState, key: string): boolean {
  for (const r of state.raised) {
    if (r.key === key) return true
  }
  // Keep the suppression list bounded. Without this it grows without limit and
  // becomes the run's memory bottleneck — the same trap as the event-log cap.
  if (state.raised.length > 4096) state.raised.splice(0, 2048)
  return false
}