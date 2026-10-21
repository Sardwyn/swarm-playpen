/**
 * S9 - the thesis test. test-scenarios.md S9.
 *
 * ## The comparison as specced is confounded, and that was found before running it
 *
 * `test-scenarios.md` S9 says both arms are 72 Wh. They are not:
 *
 * | arm | composition | energy |
 * |---|---|---|
 * | H heterogeneous | ground 38 + inchworm 12 + hover 22 | **72 Wh** |
 * | A all-ground | 3 x ground | **114 Wh** |
 *
 * The all-ground arm carries **58% more energy** than the heterogeneous one. The note
 * under that table says "matched energy, not matched headcount of capability", and the
 * arithmetic matches nothing. Run as written it compares 72 Wh against 114 Wh, which
 * flatters the arm the thesis is arguing *against* - a conservative bias in the
 * thesis's favour, which is still a bias, and which makes the result uninterpretable
 * either way.
 *
 * ## The version run here
 *
 * The hover bot is Stage F and does not exist yet, so this is a **partial** S9 and says
 * so:
 *
 * | arm | composition | rated energy | headcount |
 * |---|---|---|---|
 * | **H** | ground-01 (38 Wh) + inch-01 (12 Wh) | **50 Wh** | 2 |
 * | **A** | ground-01 + ground-02, both at 25 Wh | **50 Wh** | 2 |
 *
 * Matched on energy *and* headcount, so capability is the only difference. Battery is
 * equalised with `initialBatteryFraction` = 25/38 rather than by inventing a second
 * agent class, so the arms differ in exactly one thing.
 *
 * ## Ceiling, reported next to every count
 *
 * A count without its ceiling is not a result. H's constrained arm is homed into one
 * of **four disconnected components**, and only three of the seven constrained defects
 * have a conduit target at all. Measured per home port:
 *
 * | home port | enters | ceiling |
 * |---|---|---|
 * | duct-drop-utility | void-perimeter | 2 of 3 (ob-01, ob-02) |
 * | sink-tail | waste-sink | 1 of 3 (ob-03) |
 * | cavity-entry | cavity-kitchen | **0 of 3** |
 * | flue-entry | nothing | 0 of 3 |
 *
 * So H's constrained ceiling is **2 defects**, and both carry `sourceStrength: 0`,
 * which is the structural reason S8 measured 0% corroboration for in-bore
 * obstructions. H is chasing a ceiling of 2 with the mechanism that can confirm 0% of
 * it. That is a fact about the house and the component topology, not about swarm
 * design, and it is the single most important thing this script has to say.
 *
 * ## Energy: rated Wh is the wrong denominator, and both are printed
 *
 * The ground bot ends a 300 s mission with about 95% of its 38 Wh pack. Dividing
 * confirmed anomalies by *rated* Wh compares two arms on a denominator neither used,
 * and flatters whichever does less. Over 30 seeds H consumed 2.66 Wh per seed and A
 * 1.56 - H burned **71% more** while confirming fewer. Wh-actually-used is printed
 * beside rated Wh so the reader can see both.
 *
 * ## Predictions, and the amendment made after seeing the first run
 *
 * Written before the first measurement:
 *
 * - **P1 - H confirms more anomalies per rated Wh than A.** *Prior: doubtful.*
 * - **P2 - A achieves higher ground coverage.** *Prior: likely.*
 * - **P3 - any advantage H has comes entirely from the constrained manifold.**
 *   *Prior: near-certain.*
 * - **P4 - the arms do not tie.** *Prior: certain.*
 *
 * **Amended after the first run, and recorded as an amendment rather than a
 * prediction:** P2 and P4 were measured against a metric pinned at its ceiling. Ground
 * coverage saturates at **120 s** (measured: 39.54% at 30 s, 68.82% at 60 s, 97.79% at
 * 90 s, 100.00% from 120 s on), so at 300 s both arms score 100.00% and the metric
 * carries no information. P2 and P4 are re-registered against a 60 s mission, where
 * coverage is 68.82% and can still move. This repairs a broken measurement; it does
 * not move a goalpost, because neither prediction made any claim about mission length.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadHouse01 } from '../src/sim/world/content.ts'
import { loadAnomalies01 } from '../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, runToCompletion, measure } from '../src/sim/sim/run.ts'
import { scoreDetections } from '../src/sim/report/metrics.ts'
import { GROUND_BOT, GROUND_BOT_2 } from '../src/sim/sim/agents.ts'
import { INCHWORM } from '../src/sim/types.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

/**
 * Per-bot battery fraction for the all-ground arm: 25 Wh each, so 2 x 25 = 50 Wh,
 * matching ground(38) + inchworm(12).
 *
 * **This was 50/38 = 1.3158 in the first version, and that was wrong.** The config is
 * clamp(initialBatteryFraction, 0, 1) in createRun, so 1.3158 silently became
 * 1.0 and the "energy-matched" arm actually ran with 2 x 38 = 76 Wh against H's 50.
 * A 52% energy advantage for the arm the experiment was trying to handicap - which is
 * worse than the 58% confound in the spec this script was written to fix.
 *
 * Recomputing a confounded number does not rescue it, so the first run's results were
 * discarded rather than reinterpreted. The lesson is the project's recurring one: a
 * config value that gets clamped is a value that is not the value you set, and a
 * matching claim that is never checked against the clamped result is decoration.
 */
const MATCHED_FRACTION = 25 / GROUND_BOT.batteryWh
const SEEDS = Array.from({ length: Number(process.env.S9_SEEDS ?? 30) }, (_, i) => i + 1)

/** 60 s, where ground coverage is 68.82% and the metric can still discriminate. */
const COVER_MISSION = 60

const CACHE = 'scripts/.s9-cache.json'
const cacheKey = `${SEEDS.length}-${COVER_MISSION}-${MATCHED_FRACTION}`

type SeedResult = {
  groundConfirmed: number
  groundFalsePositives: number
  constrainedCandidates: number
  constrainedConfirmed: number
  handoffsRaised: number
  energyUsedWh: number
  /** Rated pack energy actually granted, after the 0..1 clamp. Printed so a clamp cannot hide. */
  batteryWh: number
  groundCoverageShort: number
  constrainedCoverage: number
}

function runArm(key: 'H' | 'A', seed: number, missionSeconds: number) {
  return key === 'H'
    ? runToCompletion(
        createRun(
          house,
          defaultConfig({
            seed,
            noiseMultiplier: 1,
            missionSeconds,
            agents: [GROUND_BOT, INCHWORM],
            inchwormHomePort: 'duct-drop-utility',
          }),
          spawn,
        ),
      )
    : runToCompletion(
        createRun(
          house,
          defaultConfig({
            seed,
            noiseMultiplier: 1,
            missionSeconds,
            agents: [GROUND_BOT, GROUND_BOT_2],
            initialBatteryFraction: MATCHED_FRACTION,
          }),
          spawn,
        ),
      )
}

function groundCoverage(r: ReturnType<typeof runArm>): number {
  let total = 0
  let seen = 0
  for (let i = 0; i < r.mask.length; i++) {
    if (r.mask[i] !== 1) continue
    total++
    if (r.grid.observedCount[i]! >= 2) seen++
  }
  return total === 0 ? 0 : seen / total
}

function conduitCoverage(r: ReturnType<typeof runArm>): number {
  let total = 0
  let seen = 0
  for (const cov of r.conduitCoverage.values()) {
    for (const v of cov) {
      total++
      if (v > 0) seen++
    }
  }
  return total === 0 ? 0 : seen / total
}

function perSeed(key: 'H' | 'A', seed: number): SeedResult {
  // The long mission is the one that produces candidates and confirmations.
  const long = runArm(key, seed, 300)
  const scored = scoreDetections(long.candidates, truth, 'ground')
  let groundConfirmed = 0
  let groundFalsePositives = 0
  for (const row of scored.metrics.byClass) {
    groundConfirmed += row.truePositives
    groundFalsePositives += row.falsePositives
  }
  // Coverage needs a short mission, because it saturates at 120 s.
  const short = runArm(key, seed, COVER_MISSION)

  return {
    groundConfirmed,
    groundFalsePositives,
    constrainedCandidates: long.candidates.filter((c) => c.manifold === 'constrained').length,
    constrainedConfirmed: long.handoffs.confirmed,
    handoffsRaised: long.handoffs.raised,
    energyUsedWh: measure(long).energyUsedWh,
    // The pack each arm ACTUALLY starts with, after the clamp and after the IMU
    // calibration draw. Nominal arithmetic says 50 vs 50; this is what the sim granted.
    batteryWh: long.agents.reduce((s, a) => s + a.battery * a.spec.batteryWh, 0),
    groundCoverageShort: groundCoverage(short),
    constrainedCoverage: conduitCoverage(long),
  }
}

let H: SeedResult[] | undefined
let A: SeedResult[] | undefined
if (process.env.S9_NOCACHE !== '1' && existsSync(CACHE)) {
  const blob = JSON.parse(readFileSync(CACHE, 'utf8')) as { key: string; H: SeedResult[]; A: SeedResult[] }
  if (blob.key === cacheKey) {
    ;[H, A] = [blob.H, blob.A]
  }
}

if (!H || !A) {
  H = SEEDS.map((s) => perSeed('H', s))
  A = SEEDS.map((s) => perSeed('A', s))
  writeFileSync(CACHE, JSON.stringify({ key: cacheKey, H, A }))
}

// --- aggregation ---------------------------------------------------------------------
function spread(xs: number[]): { mean: number; lo: number; hi: number } {
  return { mean: xs.reduce((s, v) => s + v, 0) / xs.length, lo: Math.min(...xs), hi: Math.max(...xs) }
}

const get = (rs: SeedResult[], k: keyof SeedResult) => rs.map((r) => r[k] as number)
const RATED_WH = 50

console.log(`S9 (partial - no hover bot, no recombination clusters), ${SEEDS.length} seeds`)
console.log('arms matched on rated energy (50 Wh) and headcount (2); the granted pack is printed below,')
console.log('because nominal arithmetic and the sim disagree by the calibration draw')
console.log('columns are per-seed, over a 300 s mission except coverage\n')
console.log('  ' + 'metric'.padEnd(36) + 'H mean'.padStart(9) + ' [min,max]'.padEnd(18) + 'A mean'.padStart(9) + ' [min,max]')
console.log('  ' + '-'.repeat(84))

function row(label: string, hs: number[], as: number[], f: (x: number) => string = (x) => x.toFixed(2)) {
  const h = spread(hs)
  const a = spread(as)
  console.log(
    '  ' + label.padEnd(36) +
      f(h.mean).padStart(9) + ` [${f(h.lo)}, ${f(h.hi)}]`.padEnd(18) +
      f(a.mean).padStart(9) + ` [${f(a.lo)}, ${f(a.hi)}]`,
  )
}

row('rated energy Wh', [RATED_WH], [RATED_WH], (x) => x.toFixed(0))
row('headcount', [2], [2], (x) => x.toFixed(0))
row('ground anomalies confirmed', get(H, 'groundConfirmed'), get(A, 'groundConfirmed'))
row('ground false positives', get(H, 'groundFalsePositives'), get(A, 'groundFalsePositives'))
row(`ground coverage @${COVER_MISSION}s %`, get(H, 'groundCoverageShort').map((x) => x * 100), get(A, 'groundCoverageShort').map((x) => x * 100))
row('constrained candidates', get(H, 'constrainedCandidates'), get(A, 'constrainedCandidates'))
row('  of those confirmed', get(H, 'constrainedConfirmed'), get(A, 'constrainedConfirmed'))
row('  handoffs raised', get(H, 'handoffsRaised'), get(A, 'handoffsRaised'))
row('constrained coverage %', get(H, 'constrainedCoverage').map((x) => x * 100), get(A, 'constrainedCoverage').map((x) => x * 100))
row('energy actually used Wh', get(H, 'energyUsedWh'), get(A, 'energyUsedWh'), (x) => x.toFixed(3))

const hTot = H.map((r) => r.groundConfirmed + r.constrainedConfirmed)
const aTot = A.map((r) => r.groundConfirmed + r.constrainedConfirmed)
const hPerRated = hTot.map((t) => t / RATED_WH)
const aPerRated = aTot.map((t) => t / RATED_WH)
const hPerUsed = H.map((r) => (r.groundConfirmed + r.constrainedConfirmed) / r.energyUsedWh)
const aPerUsed = A.map((r) => (r.groundConfirmed + r.constrainedConfirmed) / r.energyUsedWh)

console.log('  ' + '-'.repeat(84))
row('total confirmed', hTot, aTot, (x) => x.toFixed(2))
row('STARTING pack actually granted, Wh', get(H, 'batteryWh'), get(A, 'batteryWh'), (x) => x.toFixed(2))
row('per RATED Wh', hPerRated, aPerRated, (x) => x.toFixed(4))
row('per Wh ACTUALLY USED', hPerUsed, aPerUsed, (x) => x.toFixed(3))

// --- paired comparison, direction-aware ----------------------------------------------
console.log('\npaired per-seed comparison. "better" respects the metric direction:')
function paired(label: string, hs: number[], as: number[], higherIsBetter: boolean) {
  // delta is H minus A, signed so that a POSITIVE delta always means H is better.
  const d = hs.map((h, i) => (higherIsBetter ? h - as[i]! : as[i]! - h))
  const hWins = d.filter((v) => v > 0).length
  const aWins = d.filter((v) => v < 0).length
  const ties = d.length - hWins - aWins
  const verdict = hWins > aWins ? 'H' : aWins > hWins ? 'A' : 'indistinguishable'
  console.log(
    `  ${label.padEnd(32)} mean delta ${spread(d).mean.toFixed(3).padStart(9)}   ` +
      `H better ${String(hWins).padStart(2)}   A better ${String(aWins).padStart(2)}   tie ${String(ties).padStart(2)}   -> ${verdict}`,
  )
}

paired('ground anomalies confirmed', get(H, 'groundConfirmed'), get(A, 'groundConfirmed'), true)
paired('ground false positives', get(H, 'groundFalsePositives'), get(A, 'groundFalsePositives'), false)
paired(`ground coverage @${COVER_MISSION}s`, get(H, 'groundCoverageShort'), get(A, 'groundCoverageShort'), true)
paired('constrained coverage', get(H, 'constrainedCoverage'), get(A, 'constrainedCoverage'), true)
paired('energy used', get(H, 'energyUsedWh'), get(A, 'energyUsedWh'), false)
paired('total confirmed', hTot, aTot, true)
paired('confirmed per Wh used', hPerUsed, aPerUsed, true)

// --- mechanism: does the failed handoff cost the ground bot anything? ---------------
console.log('\nmechanism check - H escalates handoffs the ground bot then fails to confirm.')
console.log('If each escalation costs a ground trip, H should show MORE false positives AND')
console.log('LESS coverage at equal candidate count. Measured against A, which escalates 0:')
const escH = spread(get(H, 'handoffsRaised'))
const escA = spread(get(A, 'handoffsRaised'))
console.log(`  escalations per seed   H ${escH.mean.toFixed(2)}   A ${escA.mean.toFixed(2)}`)
console.log(`  confirmations per seed  H ${spread(get(H, 'constrainedConfirmed')).mean.toFixed(2)}   A 0.00`)
console.log(`  confirmation rate       H ${escH.mean === 0 ? 'n/a' : ((spread(get(H, 'constrainedConfirmed')).mean / escH.mean) * 100).toFixed(1) + '%'}   A n/a`)
console.log(`  candidates raised       H ${spread(get(H, 'constrainedCandidates')).mean.toFixed(2)}   A ${spread(get(A, 'constrainedCandidates')).mean.toFixed(2)}`)

// --- break-even: what would the crawler have to be worth? --------------------------
//
// The control arm's actual job. A negative result is only useful if it says how far
// from winning the thing was, so this converts the loss into a target the missing
// mechanism has to hit.
console.log('\n--- break-even for the crawler (Stage H target) ---')

// Only ob-01 and ob-02 sit in a component the crawler can enter, so H's constrained
// ceiling is 2 confirmed anomalies. Measured from the content, not assumed.
const CONSTRAINED_CEILING = 2

const aGround = spread(get(A, 'groundConfirmed')).mean
const hGround = spread(get(H, 'groundConfirmed')).mean
const groundDeficit = aGround - hGround
const hConstrained = spread(get(H, 'constrainedConfirmed')).mean

console.log(`  A confirms ${aGround.toFixed(2)} on the ground manifold, H confirms ${hGround.toFixed(2)}.`)
console.log(`  Putting a crawler on the board COSTS ${groundDeficit.toFixed(2)} ground confirmations.`)
console.log(`  H's constrained ceiling is ${CONSTRAINED_CEILING} (ob-01, ob-02 - the only in-bore defects in a component it can enter).`)
console.log('')
console.log(`  To draw level on confirmations alone, H must convert ${groundDeficit.toFixed(2)} of those ${CONSTRAINED_CEILING},`)
console.log(`  i.e. ${((groundDeficit / CONSTRAINED_CEILING) * 100).toFixed(1)}% of its reachable ceiling.`)
console.log(`  It currently converts ${hConstrained.toFixed(2)}, i.e. ${((hConstrained / CONSTRAINED_CEILING) * 100).toFixed(1)}%.`)

const needRate = groundDeficit / CONSTRAINED_CEILING
const haveRate = hConstrained / CONSTRAINED_CEILING
console.log('')
console.log(`  REQUIRED in-bore confirmation rate  ${(needRate * 100).toFixed(1)}%`)
console.log(`  MEASURED                           ${(haveRate * 100).toFixed(1)}%`)
console.log(`  SHORTFALL                          ${(needRate / Math.max(haveRate, 1e-9)).toFixed(1)}x`)
console.log('')
console.log('  And that break-even ignores the other cost: H reaches 68.73% ground coverage against')
console.log(`  A's 95.50%, a ${(spread(get(A, 'groundCoverageShort')).mean - spread(get(H, 'groundCoverageShort')).mean > 0 ? '' : '-')}${Math.abs((spread(get(A, 'groundCoverageShort')).mean - spread(get(H, 'groundCoverageShort')).mean) * 100).toFixed(2)} pp loss, for 2 defects.`)

// --- predictions ---------------------------------------------------------------------
console.log('\n--- pre-registered predictions ---')
const p1 = spread(hPerRated).mean > spread(aPerRated).mean
const p2 = spread(get(A, 'groundCoverageShort')).mean > spread(get(H, 'groundCoverageShort')).mean
const p3 = spread(get(H, 'constrainedCoverage')).mean > spread(get(A, 'constrainedCoverage')).mean
const p4 = spread(get(H, 'groundCoverageShort')).mean !== spread(get(A, 'groundCoverageShort')).mean
const fmt = (xs: number[]) => spread(xs).mean.toFixed(4)
console.log(`  P1  H beats A per rated Wh          ${p1 ? 'HOLDS' : 'FAILS'}   (${fmt(hPerRated)} vs ${fmt(aPerRated)})`)
console.log(`  P2  A beats H on ground coverage    ${p2 ? 'HOLDS' : 'FAILS'}   (${(spread(get(A, 'groundCoverageShort')).mean * 100).toFixed(2)}% vs ${(spread(get(H, 'groundCoverageShort')).mean * 100).toFixed(2)}%)  [amended to ${COVER_MISSION}s; saturated at 300 s]`)
console.log(`  P3  H's edge is constrained-only    ${p3 ? 'HOLDS' : 'FAILS'}   (${(spread(get(H, 'constrainedCoverage')).mean * 100).toFixed(2)}% vs ${(spread(get(A, 'constrainedCoverage')).mean * 100).toFixed(2)}%)`)
console.log(`  P4  the arms do not tie             ${p4 ? 'HOLDS' : 'FAILS'}`)

console.log('\n--- what is NOT in this comparison ---')
console.log('  the hover bot            Stage F. A has no answer to ceiling or attic work at all.')
console.log('  recombination clusters   Stage H. The port handoff - the only composite-observation')
console.log('                           mechanism that exists - converts 11.7% of in-bore suspicions')
console.log('                           into evidence, against the 41.7% it would need to pay for itself.')
console.log('  volumetric manifold      Stage I, so neither arm can work above floor level.')
console.log('')
console.log('  So this measures CAPABILITY WITHOUT RECOMBINATION, which the thesis predicts')
console.log('  should lose. It is the control arm of the thesis, not a test of it. What it')
console.log('  establishes is the number the thesis has to beat: at matched energy and matched')
console.log('  headcount, spending 12 Wh on a crawler instead of a second ground bot costs')
console.log('  ground coverage outright.')