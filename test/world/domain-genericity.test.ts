/**
 * What the engine may and may not know about a domain.
 *
 * ## The claim
 *
 * A domain is a content file. The engine knows about *readings* and it knows
 * about *manifolds*; it does not know what a fault is called, and it must not
 * care what a fault is called when it builds the world the fault lives in.
 *
 * ## Why this is a test and not a diagnostic
 *
 * Because the failure is silent and it is catastrophic. When the marine
 * taxonomy renamed `moisture_leak` to `active_water_ingress`, the humidity
 * field stopped being built — the field builder switched on the fault's *name*
 * — and the swarm stopped finding leaks. The run still worked, the report still
 * worked, and the recall simply fell by a third with nothing anywhere saying
 * why. A diagnostic would have printed a number; only an assertion catches it.
 *
 * So there are two tests here:
 *
 * 1. **Renaming every fault changes nothing.** Same run, same candidates, same
 *    matches. If a name can move a number, the name is doing physics.
 * 2. **A reading is only ever credited to a fault on the manifold it was taken
 *    on.** A humidity reading taken on the sole of an engine room is not
 *    evidence about a fault 850 mm above it in the deckhead void.
 */

import { describe, expect, it } from 'vitest'
import { createRun, defaultConfig, step } from '../../src/sim/sim/run.ts'
import { scoreDetections } from '../../src/sim/report/metrics.ts'
import { GROUND_BOT } from '../../src/sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../../src/sim/types.ts'
import {
  yachtHouse,
  yachtTruth,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../../src/sim/world/yacht-sim.ts'
import { loadAnomalySet } from '../../src/sim/world/anomalies.ts'
import type { Anomaly, AnomalySet } from '../../src/sim/world/anomalies.ts'
import type { Candidate } from '../../src/sim/sim/detectors.ts'

const TOTAL_TICKS = 3000

function runTheSwarm(truth: AnomalySet): ReturnType<typeof createRun> {
  const run = createRun(
    yachtHouse,
    defaultConfig({
      seed: 1,
      noiseMultiplier: 1,
      missionSeconds: 300,
      agents: [GROUND_BOT, INCHWORM, HOVER],
      inchwormHomePort: YACHT_INCHWORM_HOME,
    }),
    YACHT_SPAWN,
    truth,
  )
  while (run.tick < TOTAL_TICKS && !run.done) step(run)
  return run
}

describe('the engine does not care what a fault is called', () => {
  it('renaming every fault changes nothing about the run', () => {
    const baseline = runTheSwarm(yachtTruth)

    // Every class becomes a nonsense string. The signature — the physical
    // reading — is left alone, because that is the part the engine is allowed to
    // know about.
    const renamedRaw = {
      id: yachtTruth.id,
      houseId: yachtTruth.houseId,
      coverageThreshold: yachtTruth.coverageThreshold,
      matchDistanceM: yachtTruth.matchDistanceM,
      anomalies: yachtTruth.anomalies.map((a, i) => ({
        id: a.id,
        class: `zzz_unnamed_fault_${i}`,
        signature: a.signature,
        manifold: a.manifold,
        position: a.position,
        halfExtents: a.halfExtents,
        severity: a.severity,
        expectedDetector: a.expectedDetector,
        sourceStrength: a.sourceStrength,
        sourceSigma: a.sourceSigma,
        sign: a.sign,
        // The conduit target has to come too: a fault inside a pipe is
        // addressed by (conduit, arc), and dropping it silently removes the
        // crawler's whole reason to be there.
        ...(a.conduit === undefined ? {} : { conduit: a.conduit }),
      })),
    }
    const renamed = loadAnomalySet(renamedRaw)
    const other = runTheSwarm(renamed)

    // The same faults were detected, in the same places, by the same detectors.
    expect(other.candidates.length).toBe(baseline.candidates.length)
    for (let i = 0; i < baseline.candidates.length; i++) {
      const a = baseline.candidates[i]!
      const b = other.candidates[i]!
      expect(b.id).toBe(a.id)
      expect(b.detectorId).toBe(a.detectorId)
      expect(b.predictedClass).toBe(a.predictedClass)
      expect(b.x).toBeCloseTo(a.x, 9)
      expect(b.y).toBeCloseTo(a.y, 9)
      expect(b.z).toBeCloseTo(a.z, 9)
      expect(b.magnitude).toBeCloseTo(a.magnitude, 9)
    }
    expect(other.log.hash()).toBe(baseline.log.hash())
  })

  it('and the matches are the same faults', () => {
    const renamedRaw = {
      id: yachtTruth.id,
      houseId: yachtTruth.houseId,
      coverageThreshold: yachtTruth.coverageThreshold,
      matchDistanceM: yachtTruth.matchDistanceM,
      anomalies: yachtTruth.anomalies.map((a, i) => ({
        ...a,
        class: `zzz_unnamed_fault_${i}`,
      })),
    }
    const renamed = loadAnomalySet(renamedRaw)

    const a = runTheSwarm(yachtTruth)
    const b = runTheSwarm(renamed)

    const matchedA = scoreDetections(a.candidates, yachtTruth).matches.map((m) => m.anomaly.id).sort()
    const matchedB = scoreDetections(b.candidates, renamed).matches.map((m) => m.anomaly.id).sort()
    expect(matchedB).toEqual(matchedA)
    expect(matchedA.length).toBeGreaterThan(0)
  })
})

describe('a reading is only credited on its own manifold', () => {
  const truth: AnomalySet = {
    id: 'manifold-test',
    houseId: 'manifold-test',
    coverageThreshold: 0.85,
    matchDistanceM: 3.0,
    anomalies: [
      {
        id: 'f-1',
        class: 'a_fault_in_the_deckhead',
        signature: 'moisture_leak',
        manifold: 'volumetric',
        position: [0, 1.15, 0],
        halfExtents: [0.6, 0.2, 0.5],
        severity: 0.8,
        expectedDetector: 'humidity.baseline',
        sourceStrength: 0.3,
        sourceSigma: 0.9,
        sign: 1,
      } as Anomaly,
    ],
  }

  const groundReading: Candidate = {
    id: 'c-1',
    detectorId: 'humidity.baseline',
    predictedClass: 'moisture_leak',
    agentId: 'ground-01',
    tick: 100,
    x: 0,
    y: 0.3,
    z: 0,
    halfExtents: [0.5, 0.3, 0.5],
    confidence: 0.8,
    magnitude: 4.2,
    manifold: 'ground',
    unverified: true,
  }

  it('does not credit a reading on the floor to a fault in the void above it', () => {
    const { matches } = scoreDetections([groundReading], truth)
    expect(matches.length).toBe(0)
  })

  it('does credit it when the manifolds agree', () => {
    const onTheFloor: AnomalySet = {
      ...truth,
      anomalies: [{ ...truth.anomalies[0]!, manifold: 'ground', position: [0, 0.3, 0] }],
    }
    const { matches } = scoreDetections([groundReading], onTheFloor)
    expect(matches.length).toBe(1)
    expect(matches[0]!.anomaly.id).toBe('f-1')
  })

  it('and the distance gate is declared rather than hard-coded', () => {
    // The gate that actually gates a match is the distance, and it is read from
    // the truth set. The spec's IOU_MATCH was declared and never read, and
    // reading it would have rejected every detection in the run — including a
    // crawler sitting 0.00 m from a fuel-line obstruction, whose extent overlap
    // was 0.025. IoU measures delineation, not detection.
    const tight: AnomalySet = { ...truth, matchDistanceM: 0.1 }
    expect(scoreDetections([groundReading], tight).matches.length).toBe(0)
    expect(scoreDetections([groundReading], truth).matches.length).toBe(0)
  })
})
