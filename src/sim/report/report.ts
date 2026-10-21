/**
 * Inspection report generator. Spec §8.
 *
 * The product. And the rules in §8.2 are the reason it is worth reading:
 *
 * 1. **Every claim carries a detector ID.** No detector, no claim.
 * 2. **Absent evidence is reported, not omitted.** A negative claim about a
 *    region under COVERAGE_THRESHOLD is not merely discouraged — it is
 *    *unrepresentable*. `negativeClaim()` returns a refusal, not a sentence.
 * 3. **Confidence is a number with a derivation**, not a word.
 * 4. **Unverified findings are labelled**, and for a single-sensor finding that
 *    is the default state.
 * 5. **The report states what it could not do.**
 *
 * Rule 2 is enforced structurally rather than by discipline, because rule 2 is
 * exactly the kind of rule that gets followed until a deadline, and the failure it
 * prevents — a report that reads as a clean bill of health for a building that
 * was never inspected — is the one that would actually harm someone relying on
 * this work.
 */

import type { Candidate } from '../sim/detectors.ts'
import type { AnomalySet, Anomaly } from '../world/anomalies.ts'
import type { DetectionMetrics, ClassMetrics } from './metrics.ts'
import { scoreDetections, associateCandidates } from './metrics.ts'
import type { Room } from '../types.ts'

/** Spec §10: CONFIDENCE_MIN. */
export const CONFIDENCE_MIN = 0.6

export type CoverageSummary = {
  readonly manifold: string
  readonly fraction: number
  readonly observedCells: number
  readonly totalCells: number
}

export type RegionCoverage = {
  readonly roomId: string
  readonly roomName: string
  readonly fraction: number
}

export type Finding = {
  readonly id: string
  readonly class: string
  readonly detectorId: string
  readonly status: 'confirmed' | 'unverified'
  readonly x: number
  readonly y: number
  readonly z: number
  readonly confidence: number
  readonly magnitude: number
  readonly evidence: string
  /** Present when the finding matched an authored anomaly. */
  readonly matchedAnomalyId: string | null
  readonly localisationError: number | null
  readonly extentIou: number | null
}

export type NegativeClaim =
  | { readonly permitted: true; readonly text: string; readonly coverage: number }
  | { readonly permitted: false; readonly reason: string; readonly coverage: number }

export type InspectionReport = {
  readonly runId: string
  readonly tick: number
  readonly simSeconds: number
  readonly coverage: readonly CoverageSummary[]
  readonly regionCoverage: readonly RegionCoverage[]
  readonly findings: readonly Finding[]
  readonly metrics: DetectionMetrics
  readonly notAssessed: readonly ClassMetrics[]
  readonly withheldClaims: readonly string[]
  readonly detectorsUsed: readonly string[]
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

/**
 * Can we say "nothing found" about this region?
 *
 * The only place a negative claim is constructed, so the refusal and the
 * permission cannot diverge.
 */
export function negativeClaim(regionName: string, coverage: number, threshold: number): NegativeClaim {
  if (coverage < threshold) {
    return {
      permitted: false,
      coverage,
      reason:
        `${regionName} coverage ${pct(coverage)} is below the ${pct(threshold)} required to assert an absence. ` +
        `Report the coverage shortfall instead of an absence.`,
    }
  }
  return {
    permitted: true,
    coverage,
    text: `No anomaly detected in ${regionName} at ≥${pct(threshold)} coverage.`,
  }
}

export type ReportInput = {
  readonly runId: string
  readonly tick: number
  readonly simSeconds: number
  readonly candidates: readonly Candidate[]
  readonly truth: AnomalySet
  readonly rooms: readonly Room[]
  readonly coverage: readonly CoverageSummary[]
  readonly regionCoverage: readonly RegionCoverage[]
  readonly restrictToManifold?: 'ground' | 'constrained' | 'volumetric'
  /** Spec §10: CONFIDENCE_MIN — below this a finding is UNVERIFIED. */
  readonly confidenceMin?: number
}

export function buildReport(input: ReportInput): InspectionReport {
  const confidenceMin = input.confidenceMin ?? CONFIDENCE_MIN
  const threshold = input.truth.coverageThreshold

  const { metrics, matches } = scoreDetections(input.candidates, input.truth, input.restrictToManifold)
  const { findings: associated } = associateCandidates(input.candidates)

  const matchByCandidate = new Map(matches.map((m) => [m.candidate.id, m]))

  // **Associated findings, not raw candidates.** The report is the product and it
  // must not disagree with the metrics printed beside it: listing 49 raw
  // candidates against a metric that says 16 false positives is the kind of
  // internal inconsistency that destroys a reader's trust in every other number
  // on the page. Association happens here, in the report layer, because a finding
  // is a report concept — a detector reports sightings, not conclusions.
  const findings: Finding[] = associated
    .map((c): Finding => {
      const m = matchByCandidate.get(c.id)
      const confirmed = c.confidence >= confidenceMin && !c.unverified
      return {
        id: c.id,
        class: c.predictedClass,
        detectorId: c.detectorId,
        status: confirmed ? 'confirmed' : 'unverified',
        x: c.x,
        y: c.y,
        z: c.z,
        confidence: c.confidence,
        magnitude: c.magnitude,
        // Rule 3: the derivation, not the adjective.
        evidence:
          `${c.detectorId} on ${c.agentId} at tick ${c.tick}; ` +
          `magnitude ${c.magnitude.toFixed(2)}; confidence ${c.confidence.toFixed(2)}`,
        matchedAnomalyId: m?.anomaly.id ?? null,
        localisationError: m?.distance ?? null,
        extentIou: m?.iou ?? null,
      }
    })
    .sort((a, b) => a.id < b.id ? -1 : 1)

  const notAssessed = metrics.byClass.filter((m) => m.notAssessable)

  // Rule 2, applied: attempt a negative claim per room, and record every refusal
  // rather than emitting a sentence we are not entitled to.
  const withheldClaims: string[] = []
  for (const rc of input.regionCoverage) {
    const claim = negativeClaim(rc.roomName, rc.fraction, threshold)
    if (!claim.permitted) withheldClaims.push(claim.reason)
  }

  return {
    runId: input.runId,
    tick: input.tick,
    simSeconds: input.simSeconds,
    coverage: input.coverage,
    regionCoverage: input.regionCoverage,
    findings,
    metrics,
    notAssessed,
    withheldClaims,
    detectorsUsed: Object.keys(metrics.detectorCounts).sort(),
  }
}

/** Human-readable rendering. The viewer's metrics panel reads the same data. */
export function renderReport(report: InspectionReport): string {
  const lines: string[] = []
  lines.push(`INSPECTION REPORT — run ${report.runId}`)
  lines.push(`  ${report.tick} ticks (${report.simSeconds.toFixed(1)} s sim)`)
  lines.push('')

  lines.push('COVERAGE')
  for (const c of report.coverage) {
    lines.push(
      `  ${c.manifold.padEnd(12)} ${pct(c.fraction).padStart(8)}  ${c.observedCells}/${c.totalCells} cells`,
    )
  }
  lines.push('')

  lines.push(`FINDINGS (${report.findings.length})`)
  if (report.findings.length === 0) {
    lines.push('  none')
  }
  for (const f of report.findings) {
    const loc = f.localisationError === null ? 'unmatched' : `err ${f.localisationError.toFixed(2)} m`
    lines.push(
      `  ${f.status === 'confirmed' ? 'CONFIRMED' : 'UNVERIFIED'}  ${f.class.padEnd(18)} ` +
        `conf ${f.confidence.toFixed(2)}  ${f.detectorId.padEnd(22)} ${loc}`,
    )
    lines.push(`      ${f.evidence}`)
  }
  lines.push('')

  lines.push('PER-CLASS METRICS')
  for (const m of report.metrics.byClass) {
    if (m.notAssessable) {
      lines.push(`  ${m.cls.padEnd(18)} NOT ASSESSABLE — ${m.notAssessableReason}`)
      continue
    }
    const loc = m.meanLocalisationError === null ? '—' : `${m.meanLocalisationError.toFixed(2)} m`
    const iou = m.meanExtentIou === null ? '—' : m.meanExtentIou.toFixed(2)
    lines.push(
      `  ${m.cls.padEnd(18)} P ${m.precision.toFixed(2)}  R ${m.recall.toFixed(2)}  F1 ${m.f1.toFixed(2)}  ` +
        `loc ${loc.padStart(6)}  IoU ${iou.padStart(4)}  (tp ${m.truePositives} fp ${m.falsePositives} fn ${m.falseNegatives})`,
    )
  }
  lines.push('')

  lines.push(`FALSE POSITIVES PER RUN  ${report.metrics.falsePositivesPerRun}`)
  lines.push('')

  lines.push('WITHHELD CLAIMS (spec §8.2 rule 2)')
  if (report.withheldClaims.length === 0) {
    lines.push('  none — every region met the coverage threshold')
  }
  for (const w of report.withheldClaims) {
    lines.push(`  - ${w}`)
  }
  lines.push('')

  lines.push('DETECTORS USED')
  for (const d of report.detectorsUsed) {
    lines.push(`  ${d.padEnd(24)} ${report.metrics.detectorCounts[d]} candidate(s)`)
  }

  return lines.join('\n')
}

/** Anomalies with no matching finding, for the report's "what it could not do" list. */
export function missedAnomalies(report: InspectionReport, truth: AnomalySet): Anomaly[] {
  const found = new Set(
    report.findings.map((f) => f.matchedAnomalyId).filter((v): v is string => v !== null),
  )
  return truth.anomalies.filter((a) => !found.has(a.id))
}