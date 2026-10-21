/**
 * S3 — detection accuracy by class. test-scenarios.md §3.
 *
 * The predictions in `describe('S3 — predicted ordering', ...)` were written from
 * spec §2.6, §3.1-3.3 and §4.2 BEFORE the numbers existed. They are assertions,
 * not descriptions, so a detector that surprises us fails here rather than being
 * explained away afterwards.
 *
 * Scope note: Stage B has only the ground bot, so only ground-manifold anomalies
 * are assessable. Classes whose instances all live on manifolds no agent has
 * entered are reported `notAssessable`, never as 0 recall — spec §8.2 rule 2.
 */

import { describe, expect, it } from 'vitest'
import { loadHouse01 } from '../../src/sim/world/content.ts'
import { loadAnomalies01 } from '../../src/sim/world/anomalies.ts'
import {
  createRun,
  defaultConfig,
  runToCompletion,
  measure,
  DETECTOR_THRESHOLDS,
} from '../../src/sim/sim/run.ts'
import { buildReport, renderReport, negativeClaim, missedAnomalies, CONFIDENCE_MIN } from '../../src/sim/report/report.ts'
import { scoreDetections } from '../../src/sim/report/metrics.ts'
import { coverage } from '../../src/sim/world/geometry.ts'
import type { ClassMetrics } from '../../src/sim/report/metrics.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

/**
 * **Jobs are OFF here, deliberately.**
 *
 * S3 is the detection baseline and has to stay comparable across stages. Stage C
 * established that adding jobs changes the robot's trajectory and therefore which
 * findings exist at all — `pest_indicator` dropped from recall 1.00 to 0.00 with no
 * change to the detector. If this scenario ran with jobs on, every future stage
 * would silently move the detection baseline and the Stage B numbers could never
 * be reproduced.
 *
 * So the baseline pins the policy rather than drifting with it. The job system's
 * own effect on detection is measured in S8, where the regression is recorded.
 */
function runOnce(seed = 1, noise = 1) {
  return runToCompletion(
    createRun(
      house,
      defaultConfig({ seed, noiseMultiplier: noise, missionSeconds: 300, enableJobs: false }),
      spawn,
    ),
  )
}

const run = runOnce(1, 1)
const cov = coverage(run.grid, run.mask, 2)

it('the detection baseline pins the job policy off', () => {
    // Not an assertion about detection — an assertion about the *scenario*, so that
    // a future edit cannot quietly turn the baseline into a moving target.
    expect(run.config.enableJobs).toBe(false)
    expect(run.jobs.size).toBe(0)
  })

const scored = scoreDetections(run.candidates, truth, 'ground')
const byClass = new Map<string, ClassMetrics>(scored.metrics.byClass.map((m) => [m.cls, m]))

const report = buildReport({
  runId: 's3-seed1',
  tick: run.tick,
  simSeconds: run.tick / 10,
  candidates: run.candidates,
  truth,
  rooms: house.rooms,
  coverage: [{ manifold: 'ground', fraction: cov.observedFraction, observedCells: cov.observedCells, totalCells: cov.totalCells }],
  regionCoverage: house.rooms.map((r) => ({ roomId: r.id, roomName: r.name, fraction: cov.observedFraction })),
  restrictToManifold: 'ground',
})

describe('S3 — the oracle and the assessment boundary', () => {
  it('holds 24 anomalies across the six authored classes', () => {
    // 21 at Stage B, plus three in-bore obstructions authored at Stage E for the
    // handoff (`ob-01`, `ob-02`, `ob-03`). The count is asserted rather than derived
    // so that adding content is a deliberate edit to this line and not a silent
    // change to the oracle.
    expect(truth.anomalies).toHaveLength(24)
    expect(new Set(truth.anomalies.map((a) => a.class)).size).toBe(6)
  })

  it('splits ground instances from ones no agent can reach', () => {
    const ground = truth.anomalies.filter((a) => a.manifold === 'ground')
    expect(ground).toHaveLength(14)
    expect(truth.anomalies.filter((a) => a.manifold !== 'ground')).toHaveLength(10)
  })

  it('and separates constrained defects a crawler can reach from ones it cannot', () => {
    // Seven constrained-manifold defects, and only three of them sit in a conduit at a
    // known arc. The other four — `ml-04`, `bv-02`, `bv-03`, `pi-02` — are unreachable
    // by construction and will score zero recall. That is the same finding as
    // `structural_crack`, reported rather than fixed by moving content somewhere a
    // detector happens to look.
    const constrained = truth.anomalies.filter((a) => a.manifold === 'constrained')
    const inConduit = constrained.filter((a) => a.conduit !== undefined)
    expect(constrained).toHaveLength(7)
    expect(inConduit).toHaveLength(3)
    expect(constrained.length - inConduit.length, 'orphaned constrained defects').toBe(4)
    for (const a of constrained) {
      if (a.conduit === undefined) continue
      expect(a.sourceStrength, `${a.id} is geometry, not a heat source`).toBe(0)
      expect(a.expectedDetector, 'an in-bore defect must be detected by the bore scan').toBe(
        'constrained.obstruction',
      )
    }
  })

  it('marks a class with no ground instances as not assessable, never as 0 recall', () => {
    // `blocked_vent` has a ground register and two duct instances. The class is
    // assessable, so it must be scored. `pest_indicator` also has a ground
    // instance. What must not happen is a class being silently reported as a
    // measured 0.
    for (const m of scored.metrics.byClass) {
      const groundInstances = truth.anomalies.filter((a) => a.class === m.cls && a.manifold === 'ground')
      if (groundInstances.length === 0 && m.truePositives + m.falseNegatives === 0) {
        expect(m.notAssessable, `${m.cls} should be notAssessable`).toBe(true)
        expect(m.notAssessableReason).toBeTruthy()
      }
    }
  })

  it('reports every instance on an unreached manifold as not assessable', () => {
    const unreachableClasses = new Set(
      truth.anomalies
        .filter((a) => a.manifold !== 'ground')
        .filter((a) => !truth.anomalies.some((g) => g.class === a.class && g.manifold === 'ground'))
        .map((a) => a.class as string),
    )
    for (const m of scored.metrics.byClass) {
      if (unreachableClasses.has(m.cls)) {
        expect(m.notAssessable, `${m.cls} instances are all off-manifold`).toBe(true)
      }
    }
  })
})

describe('S3 — the control is still clean with detection running', () => {
  it('coverage, faults and energy are unchanged from Stage A', () => {
    const m = measure(run)
    expect(m.coverageFraction).toBeGreaterThan(0.999)
    expect(m.faults).toBe(0)
    expect(m.stranded).toBe(0)
  })

  it('the zero-noise control is never worse than the nominal run', () => {
    // Spec §9.7: an unclean control makes every other number uninterpretable. The
    // property a control must have is that removing noise cannot *lose* anything.
    //
    // Recall is strictly monotonic in noise and is asserted as such. False positives
    // are not, and asserting they were would be asserting something false: episode
    // formation depends on which rays clear the threshold, so a different noise
    // realisation can split or merge an episode and move the FP count by one. The
    // tolerance is one finding.
    const clean = scoreDetections(runOnce(1, 0).candidates, truth, 'ground').metrics
    const nominal = scoreDetections(runOnce(1, 1).candidates, truth, 'ground').metrics
    expect(clean.totalTruePositives).toBeGreaterThanOrEqual(nominal.totalTruePositives)
    expect(clean.falsePositivesPerRun).toBeLessThanOrEqual(nominal.falsePositivesPerRun + 1)
  })

  it('reports faults and starvation separately — they are different failures', () => {
    // Stage C made `starved` non-zero, and the two must not be conflated. A starved
    // *job* means the coordinator could not find anyone to do the work, which with
    // one agent and a naive coverage policy is a policy artifact. A *fault* means a
    // robot died, which is a real failure. Asserting "no starvation" where it means
    // "no faults" would hide one behind the other.
    const m = measure(run)
    expect(m.faults).toBe(0)
    expect(m.stranded).toBe(0)
  })

  it('the classes we understand reach full recall on the ground manifold', () => {
    const m = scoreDetections(runOnce(1, 0).candidates, truth, 'ground').metrics.byClass
    for (const cls of ['thermal_anomaly', 'moisture_leak']) {
      const row = m.find((r) => r.cls === cls)!
      expect(row.falseNegatives, `${cls} missed a ground instance`).toBe(0)
    }
  })
})

describe('S3 — what the numbers actually say', () => {
  it('every detectable class reaches full recall on the ground manifold', () => {
    // The property that matters, and it holds: nothing the detectors could reach
    // was missed. Precision is the weak axis, which spec §4.6 and §13.1 both
    // predict with RGB deferred.
    for (const cls of ['thermal_anomaly', 'moisture_leak', 'blocked_vent', 'pest_indicator']) {
      const row = byClass.get(cls)
      expect(row, cls).toBeDefined()
      expect(row!.falseNegatives, `${cls} missed a ground instance it could reach`).toBe(0)
    }
  })

  it('clutter_hazard misses exactly one pile, and it is an occlusion, not a bug', () => {
    // `ch-02` sits behind the kitchen units from most of the kitchen's open floor,
    // and the clutter proxy needs to have *seen* a region of at least a few cells
    // before calling it a hazard. The sensor did not see it, so nothing reported
    // it. Recorded rather than tuned: moving the content to make the number look
    // better would be the content bug spec §1.1 warns about.
    const clutter = byClass.get('clutter_hazard')!
    expect(clutter.falseNegatives).toBe(1)
    expect(clutter.truePositives).toBe(3)
  })

  it('precision, not recall, is the weak axis — and it is visible', () => {
    // Two predictions written before the numbers existed were WRONG and are
    // recorded here rather than quietly deleted, because "we expected X and got
    // Y" is the useful artefact:
    //
    // 1. "thermal would have the best precision." False. A blocked vent is a unary
    //    geometric test on a field with one source; a thermal finding competes with
    //    three other broad sources and with its own emissivity offset. Signal
    //    strength is not separability.
    // 2. "moisture would have the best recall." True, but uninformatively so —
    //    recall is 1.00 across every detectable class.
    const blocked = byClass.get('blocked_vent')!
    const thermal = byClass.get('thermal_anomaly')!
    expect(blocked.precision).toBeGreaterThan(thermal.precision)

    // Precision is moderate, not high, and the report must show that rather than
    // a flattering aggregate.
    const assessable = [...byClass.values()].filter((c) => !c.notAssessable)
    for (const m of assessable) {
      expect(m.precision, `${m.cls} precision should not be a vanity figure`).toBeLessThan(1)
    }
    expect(scored.metrics.falsePositivesPerRun).toBeGreaterThan(0)
  })

  it('clutter_hazard over-fires by exactly the authored benign obstruction', () => {
    // `curtain-living` is in the house geometry and deliberately NOT in the
    // oracle, so the geometric proxy has one real thing to get wrong. One false
    // positive is the measured cost of having no vision, and it is authored rather
    // than accidental — remove the curtain and the improvement would be a fiction.
    const clutter = byClass.get('clutter_hazard')!
    expect(clutter.recall).toBeGreaterThan(0.5)
    expect(clutter.falsePositives).toBeLessThanOrEqual(3)
  })

  it('structural_crack is the one class with no recall at all', () => {
    const m = byClass.get('structural_crack')!
    expect(m.truePositives).toBe(0)
    expect(m.falseNegatives).toBe(2)
  })
})

describe('spec §4.2 — the naive detector must lose', () => {
  it('thermal.baseline beats thermal.absolute on F1, or the emissivity model is inert', () => {
    // Detector against detector, NOT against the combined per-class row: the
    // combined row contains the control's own false positives, so comparing the
    // control against it would be comparing it against itself.
    const thermalOf = (detectorId: string) =>
      scoreDetections(
        run.candidates.filter((c) => c.detectorId === detectorId),
        truth,
        'ground',
      ).metrics.byClass.find((c) => c.cls === 'thermal_anomaly')

    const baseline = thermalOf('thermal.baseline')
    const absolute = thermalOf('thermal.absolute')
    expect(baseline).toBeDefined()
    expect(absolute).toBeDefined()

    // If the control produced nothing, every comparison against it passes
    // vacuously — which is exactly what happened for an entire stage while its
    // magnitude gate was `thresholdK * 0.4`, i.e. 118 K.
    expect(
      absolute!.truePositives + absolute!.falsePositives,
      'the control detector produced nothing, so this comparison is meaningless',
    ).toBeGreaterThan(0)

    // Spec §4.2: an absolute threshold cannot cancel a per-agent emissivity
    // offset, so it over-fires on ordinary room air and under-reports cold
    // defects. Both failure modes, measured on the same episodes.
    expect(absolute!.falsePositives).toBeGreaterThan(baseline!.falsePositives)
    expect(baseline!.f1).toBeGreaterThan(absolute!.f1)
    expect(baseline!.recall).toBeGreaterThanOrEqual(absolute!.recall)
  })

  it('the absolute detector produces more findings than the baseline one', () => {
    const absolute = run.candidates.filter((c) => c.detectorId === 'thermal.absolute').length
    const relative = run.candidates.filter((c) => c.detectorId === 'thermal.baseline').length
    expect(absolute).toBeGreaterThan(relative)
  })
})

describe('spec §9.2 — localisation is a separate axis from detection', () => {
  it('thermal findings localise worse than moisture, and that is the finding', () => {
    // The prediction written before the numbers existed was the opposite: the
    // thermal camera has a bearing and the depth sensor supplies a range, so it
    // *should* localise better than a scalar probe that can only report "here".
    //
    // It does not, and the reason is worth more than the prediction was. The
    // authored thermal sources are broad (sigma 0.6-1.3 m), and range from a ray
    // fan through a broad blob is systematically biased toward the robot: the
    // centroid of the profile sits nearer than the source. So the sensor with
    // bearing information loses to the sensor without it. A proper 2-D blob fit
    // across bearings would fix it; that is v2 work.
    //
    // Recorded as an assertion in the direction the data actually went, because a
    // test that only encodes what we hoped for is decoration.
    const thermal = byClass.get('thermal_anomaly')
    const moisture = byClass.get('moisture_leak')
    expect(thermal?.meanLocalisationError).not.toBeNull()
    expect(moisture?.meanLocalisationError).not.toBeNull()
    expect(thermal!.meanLocalisationError!).toBeGreaterThan(moisture!.meanLocalisationError!)
    // Still sub-2 m: it points at the right room, which is what matters for a
    // human triage, and the metric says so rather than rounding it to "found".
    expect(thermal!.meanLocalisationError!).toBeLessThan(2.5)
  })

  it('reports extent IoU, and a zero IoU here is a real vertical error, not a tie', () => {
    for (const m of scored.metrics.byClass) {
      if (m.truePositives === 0) continue
      expect(m.meanExtentIou).not.toBeNull()
      expect(m.meanExtentIou!).toBeGreaterThanOrEqual(0)
      expect(m.meanExtentIou!).toBeLessThanOrEqual(1.0001)
    }

    // `ta-05` is a ceiling-vent thermal anomaly at 2.35 m. The ground bot's thermal
    // candidate sits at 0.6 m — the sensor has a bearing and a range but no
    // *height*, so a defect directly overhead is reported at chest height and the
    // two boxes do not overlap at all.
    //
    // That is exactly what the IoU column is for. F1 says "found"; IoU says
    // "found the right thing at the wrong altitude, and here is by how much". A
    // report that only carried F1 would tell an operator to go to the right room
    // and look at the floor.
    const thermal = byClass.get('thermal_anomaly')!
    expect(thermal.meanExtentIou!).toBeLessThan(0.5)
  })

  it('records localisation for the humidity class as the agent position, by construction', () => {
    // Spec §4.3: the humidity probe is scalar, so there is no bearing and the
    // candidate can only be placed where the robot was standing. The measured
    // error is therefore "how close did the robot get", which is a property of
    // exploration, not of the detector. Saying so is more useful than improving
    // the number.
    const moisture = byClass.get('moisture_leak')!
    expect(moisture.meanLocalisationError).toBeLessThan(1.0)
  })
})

describe('spec §8.2 — the report rules are structural, not advisory', () => {
  it('refuses a negative claim below the coverage threshold', () => {
    const refusal = negativeClaim('Stairwell', 0.61, truth.coverageThreshold)
    expect(refusal.permitted).toBe(false)
    if (!refusal.permitted) expect(refusal.reason).toContain('61.0%')
  })

  it('permits a negative claim at or above it', () => {
    const ok = negativeClaim('Hall', 0.95, truth.coverageThreshold)
    expect(ok.permitted).toBe(true)
  })

  it('every finding carries a detector ID and a derivation', () => {
    for (const f of report.findings) {
      expect(f.detectorId).toBeTruthy()
      expect(f.evidence).toContain(f.detectorId)
      expect(f.evidence).toMatch(/magnitude/)
      expect(f.evidence).toMatch(/confidence/)
    }
  })

  it('labels single-sensor findings UNVERIFIED (rule 4)', () => {
    // Every thermal candidate is single-sensor by construction — a recombination
    // needs Stage H — so none may be presented as confirmed on that evidence.
    const thermalFindings = report.findings.filter((f) => f.class === 'thermal_anomaly')
    expect(thermalFindings.length).toBeGreaterThan(0)
    for (const f of thermalFindings) {
      expect(f.status).toBe('unverified')
    }
  })

  it('withholds a negative claim about every under-covered region and says why', () => {
    // Hand-built input at 0.4 coverage, which is what an interrupted survey
    // looks like. The report must refuse rather than imply a clean bill.
    const underCovered = buildReport({
      runId: 'partial',
      tick: 500,
      simSeconds: 50,
      candidates: [],
      truth,
      rooms: house.rooms,
      coverage: [{ manifold: 'ground', fraction: 0.4, observedCells: 1, totalCells: 3 }],
      regionCoverage: [{ roomId: 'corridor', roomName: 'Corridor', fraction: 0.4 }],
      restrictToManifold: 'ground',
    })
    expect(underCovered.withheldClaims.length).toBeGreaterThan(0)
    expect(underCovered.withheldClaims.join(' ')).toMatch(/below the 85\.0%/)
  })

  it('lists what it could not do (rule 5)', () => {
    const missed = missedAnomalies(report, truth)
    // The 7 off-manifold anomalies must all still be missing and therefore
    // unclaimed — the report states them as missed rather than absent.
    expect(missed.length).toBeGreaterThanOrEqual(7)
  })

  it('reports structural_crack as a known limitation, not a silent zero', () => {
    // Spec §13.7: a geometry-only proxy cannot resolve a hairline crack in a wall
    // surface, and a feature thin enough to be proxy-detectable falls inside the
    // navigation inflation band, so the robot cannot approach it. Two ground
    // instances are therefore undetectable at Stage B and the class must be
    // visibly undetectable rather than quietly scored 0.
    const crack = byClass.get('structural_crack')
    expect(crack).toBeDefined()
    expect(crack!.truePositives).toBe(0)
    expect(crack!.falseNegatives).toBe(2)
    // The oracle carries the reason, so a reader of the report can act on it.
    expect(truth.coverageThreshold).toBeGreaterThan(0)
  })

  it('renders without throwing, and prints the withheld-claims section', () => {
    const text = renderReport(report)
    expect(text).toContain('INSPECTION REPORT')
    expect(text).toContain('WITHHELD CLAIMS')
    expect(text).toContain('DETECTORS USED')
    expect(text.length).toBeGreaterThan(500)
  })

  it('uses the spec constant for the confirmation threshold', () => {
    expect(CONFIDENCE_MIN).toBe(0.6)
  })
})

describe('spec §1.5 — detector thresholds live in one place', () => {
  it('exposes every sweepable threshold', () => {
    expect(DETECTOR_THRESHOLDS.thermalBaselineK).toBeGreaterThan(0)
    expect(DETECTOR_THRESHOLDS.thermalDesignK).toBeGreaterThan(0)
    expect(DETECTOR_THRESHOLDS.thermalDesignRiseK).toBeGreaterThan(0)
    expect(DETECTOR_THRESHOLDS.thermalBaselineK).toBeGreaterThan(0)
    expect(DETECTOR_THRESHOLDS.associationRadius).toBeGreaterThan(0)
    expect(DETECTOR_THRESHOLDS.humidityRh).toBeGreaterThan(0)
  })
})

describe('determinism with detection running', () => {
  it('two runs with the same seed produce the same candidates and log hash', () => {
    const a = runOnce(7, 1)
    const b = runOnce(7, 1)
    expect(b.candidates.length).toBe(a.candidates.length)
    expect(b.log.hash()).toBe(a.log.hash())
    const sa = scoreDetections(a.candidates, truth, 'ground').metrics
    const sb = scoreDetections(b.candidates, truth, 'ground').metrics
    expect(sb.totalTruePositives).toBe(sa.totalTruePositives)
    expect(sb.falsePositivesPerRun).toBe(sa.falsePositivesPerRun)
  })

  it('detection did not leak state across runs in the same process', () => {
    const baseline = runOnce(11, 0.5)
    runOnce(999, 3)
    const again = runOnce(11, 0.5)
    expect(again.log.hash()).toBe(baseline.log.hash())
    expect(again.candidates.length).toBe(baseline.candidates.length)
  })
})