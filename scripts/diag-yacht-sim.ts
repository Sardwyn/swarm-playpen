/**
 * Run the swarm on the yacht and report what it found, and what it could not.
 *
 * ## What this is for
 *
 * The house domain measures whether the swarm works. This measures what the swarm
 * **cannot do**, which is the question the product turns on.
 *
 * The claim under test: on a midships section of a Sunseeker Predator 55, the
 * forward stringer void is the largest volume on the boat, it holds the most severe
 * authored fault, and it is unreachable — because its only apertures are two 200 mm
 * deck hatches and every agent in the swarm is wider than that.
 *
 * If the run finds the fault, the claim is wrong and something in the geometry is
 * wrong. A test that cannot fail is a diagnostic that cannot fail.
 *
 * Run: `npm run diag:yacht-sim`
 */

import { createRun, defaultConfig, step, coverageGaps } from '../src/sim/sim/run.ts'
import { buildReport } from '../src/sim/report/report.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'
import { HOVER, INCHWORM, isLumenPose } from '../src/sim/types.ts'
import {
  yachtHouse,
  yachtTruth,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../src/sim/world/yacht-sim.ts'
import { coverage } from '../src/sim/world/geometry.ts'

const SEED = 1
const NOISE = 1
const MISSION_SECONDS = 300
const TOTAL_TICKS = 3000

const run = createRun(
  yachtHouse,
  defaultConfig({
    seed: SEED,
    noiseMultiplier: NOISE,
    missionSeconds: MISSION_SECONDS,
    // The house's reference configuration is one ground bot, because that is what
    // the house scenarios needed. A boat needs all three, and the point of the
    // domain is that they have different access.
    agents: [GROUND_BOT, INCHWORM, HOVER],
    inchwormHomePort: YACHT_INCHWORM_HOME,
  }),
  YACHT_SPAWN,
  yachtTruth,
)

while (run.tick < TOTAL_TICKS && !run.done) {
  step(run)
}

const cov = coverage(run.grid, run.mask, 2)

/**
 * Coverage of one room, from the cells actually inside it.
 *
 * The global figure would put every room at the same number, and the withheld-claims
 * rule exists to stop exactly that. Same approach as the house viewer.
 */
function roomCoverage(aabb: {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}): number {
  const g = run.grid
  const cx0 = Math.floor((aabb.minX - g.minX) / 0.05)
  const cx1 = Math.floor((aabb.maxX - g.minX) / 0.05)
  const cz0 = Math.floor((aabb.minZ - g.minZ) / 0.05)
  const cz1 = Math.floor((aabb.maxZ - g.minZ) / 0.05)
  let total = 0
  let observed = 0
  for (let cz = Math.max(0, cz0); cz <= Math.min(g.height - 1, cz1); cz++) {
    for (let cx = Math.max(0, cx0); cx <= Math.min(g.width - 1, cx1); cx++) {
      const i = cz * g.width + cx
      if (run.mask[i] !== 1) continue
      total++
      if (g.observedCount[i]! >= 2) observed++
    }
  }
  return total === 0 ? 1 : observed / total
}

const report = buildReport({
  runId: `yacht-seed-${SEED}`,
  tick: run.tick,
  simSeconds: run.tick / 10,
  candidates: run.candidates,
  truth: run.truth,
  rooms: yachtHouse.rooms,
  coverage: [
    {
      manifold: 'ground',
      fraction: cov.observedFraction,
      observedCells: cov.observedCells,
      totalCells: cov.totalCells,
    },
  ],
  regionCoverage: yachtHouse.rooms.map((r) => ({
    roomId: r.id,
    roomName: r.name,
    fraction: roomCoverage(r.aabb),
  })),
  // No manifold restriction. Restricting to 'ground' removes the volumetric
  // anomalies from the match pool altogether, which would make the deckhead and
  // stringer-void faults look missed for a reason that is an artefact of the
  // diagnostic rather than a property of the swarm.
})

function head(t: string): void {
  console.log('')
  console.log(t)
  console.log('-'.repeat(78))
}

head('RUN')
console.log(`  seed ${SEED}  noise ${NOISE}  ticks ${run.tick}  done ${run.done}`)
console.log(`  log hash ${run.log.hash()}`)
console.log(`  candidates ${run.candidates.length}  findings ${report.findings.length}`)
console.log(
  `  ground coverage ${(cov.observedFraction * 100).toFixed(1)}%  ` +
    `(${cov.observedCells}/${cov.totalCells} cells)  uncovered ${coverageGaps(run).length}`,
)
for (const r of report.regionCoverage) {
  console.log(`  room '${r.roomName}' coverage ${(r.fraction * 100).toFixed(1)}%`)
}

head('AGENTS — where each one ended up')
for (const a of run.agents) {
  const where = isLumenPose(a.pose)
    ? `conduit ${a.pose.conduitId || '—'} @ ${a.pose.arc.toFixed(2)} m`
    : `(${a.pose.x.toFixed(2)}, ${a.pose.z.toFixed(2)})` +
      ('y' in a.pose ? `, y ${a.pose.y.toFixed(2)}` : '')
  console.log(
    `  ${a.spec.id.padEnd(10)} ${a.spec.cls.padEnd(10)} ${a.manifold.padEnd(12)} ${where.padEnd(40)} ` +
      `battery ${(a.battery * 100).toFixed(0)}%  ${a.faulted ? 'FAULTED' : ''}`,
  )
}

head('FINDINGS')
for (const f of report.findings) {
  console.log(
    `  ${f.id.padEnd(12)} ${f.class.padEnd(18)} ${f.detectorId.padEnd(24)} ` +
      `conf ${f.confidence.toFixed(2)}  (${f.x.toFixed(2)}, ${f.z.toFixed(2)})  ` +
      `matched ${f.matchedAnomalyId ?? '—'}`,
  )
}

head('THE ORACLE — found or missed')
const matched = new Set(
  report.findings.map((f) => f.matchedAnomalyId).filter((id): id is string => id !== null),
)
const reasons = new Map(
  run.truth.anomalies
    .filter((a) => (a as unknown as { missReason?: string }).missReason !== undefined)
    .map((a) => [a.id, (a as unknown as { missReason: string }).missReason]),
)

/**
 * Classify a miss by what actually caused it, measured rather than asserted.
 *
 * The distinction that matters: did the **architecture of the boat** stop the swarm,
 * or did the **detector** fail? The first is the product — it is what a surveyor
 * cannot do and a robot might. The second is a detector limitation, and reporting
 * it as a coverage failure would be dishonest.
 *
 * ## Why the candidates, and not the agents' final poses
 *
 * An agent's final pose is where it stopped, not where it worked. The ground bot
 * covered 98.9% of the engine room and finished in a corner; measuring a fault
 * against that corner would call a fault four metres away "unreachable" when the
 * swarm had been right past it. The candidates are the record of where the swarm
 * actually detected *something*, so the nearest candidate is the honest measure of
 * how close the swarm got.
 *
 * So: a candidate within a metre of the fault means the swarm was there and the
 * detector did not match it — a detection miss. No candidate anywhere near means
 * the swarm never got there — an architectural miss.
 */
function classifyMiss(manifold: string, position: readonly [number, number, number]): string {
  const onManifold = run.agents.filter((a) => a.manifold === manifold)
  if (onManifold.length === 0) {
    return 'ARCHITECTURE — no agent in the swarm lives on this manifold'
  }
  let nearest = Number.POSITIVE_INFINITY
  let nearestId = '—'
  for (const c of run.candidates) {
    const d = Math.hypot(c.x - position[0], c.z - position[2])
    if (d < nearest) {
      nearest = d
      nearestId = c.detectorId
    }
  }
  const kind = nearest <= 1.0 ? 'DETECTION' : 'ARCHITECTURE'
  const agents = onManifold
    .map((a) => (isLumenPose(a.pose) ? `${a.spec.id} (in a conduit)` : a.spec.id))
    .join(', ')
  return `${kind} — agents on this manifold: ${agents}; nearest candidate ${nearestId} at ${nearest.toFixed(2)} m`
}

let missed = 0
for (const a of run.truth.anomalies) {
  const hit = matched.has(a.id)
  if (!hit) missed++
  console.log(
    `  ${a.id.padEnd(8)} ${a.class.padEnd(18)} ${a.manifold.padEnd(12)} sev ${a.severity.toFixed(2)}  ` +
      `${hit ? 'FOUND' : 'MISSED'}`,
  )
  if (!hit) {
    console.log(`      ${classifyMiss(a.manifold, a.position)}`)
    const why = reasons.get(a.id)
    if (why !== undefined) console.log(`      ${why}`)
  }
}
console.log('')
console.log(`  ${run.truth.anomalies.length - missed} found, ${missed} missed`)
console.log(`  withheld claims in the report: ${
  (report as unknown as { withheldClaims?: unknown[] }).withheldClaims?.length ?? 0
}`)
