/**
 * Browser entry point.
 *
 * Runs the *same* simulation code the headless tests run (ADR-001 §2.2): the viewer
 * drives `createRun`/`step` and reads frames. A bug reproduced in the browser is a
 * bug in the tests, not a rendering artefact, and that is only true because there
 * is exactly one implementation of the simulation.
 */

import { Viewer } from './viewer.ts'
import { MetricsPanel } from './panel.ts'
import { loadHouse01 } from '../sim/world/content.ts'
import { isLumenPose } from '../sim/types.ts'
import { createRun, defaultConfig, measure, coverageGaps, step } from '../sim/sim/run.ts'
import { coverage } from '../sim/world/geometry.ts'
import type { SimRun } from '../sim/sim/run.ts'
import { buildReport } from '../sim/report/report.ts'
import type { InspectionReport } from '../sim/report/report.ts'
import { frameFromRun } from '../sim/report/frame.ts'
import { allocationRegret, auctionVerdict, formatVerdict } from '../sim/jobs/market.ts'

const house = loadHouse01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

const stage = document.getElementById('stage')!
const side = document.getElementById('side')!

let seed = 1
let noise = 1
let jobs = true
let running = false

const viewer = new Viewer({ container: stage })

let currentRun: SimRun | null = null
let currentReport: InspectionReport | null = null

const panel = new MetricsPanel(side, {
  onToggle: (layer, on) => {
    ;(viewer.layers as unknown as Record<string, boolean>)[layer] = on
    redrawPanel()
  },
  onSelect: (id) => {
    viewer.select(id)
    const finding = currentReport?.findings.find((f) => f.id === id)
    if (finding !== undefined) viewer.focusOn(finding.x, finding.z)
    redrawPanel()
  },
  onRerun: (s, n, j) => {
    seed = s
    noise = n
    jobs = j
    void simulate()
  },
})

stage.addEventListener('click', (e) => {
  const id = viewer.pick(e.clientX, e.clientY)
  viewer.select(id)
  const finding = currentReport?.findings.find((f) => f.id === id)
  if (finding !== undefined) viewer.focusOn(finding.x, finding.z)
  redrawPanel()
})

/**
 * Run the simulation to completion, then hand the viewer a frame.
 *
 * Chunked on a **timer**, not on `requestAnimationFrame`. The first cut yielded on
 * rAF and ran at roughly four ticks per second in a headless browser, because
 * rAF is throttled when nothing is compositing — so the simulation's throughput
 * silently became a function of the frame rate. That is the worst possible coupling
 * in a project whose whole claim is that the browser and the headless runner
 * produce identical numbers.
 *
 * The simulation itself is unchanged and still deterministic: yielding between
 * ticks does not affect its state, because the sim never reads a clock
 * (ADR-001 §2.4). The viewer keeps its own rAF loop for rendering.
 */
async function simulate(): Promise<void> {
  if (running) return
  running = true
  setStatus('running…')

  const run = createRun(
    house,
    defaultConfig({ seed, noiseMultiplier: noise, missionSeconds: 300, enableJobs: jobs }),
    spawn,
  )

  const total = 3000
  while (run.tick < total && !run.done) {
    const deadline = Date.now() + 40
    // Keep stepping while there is budget left in this slice. The chunk is bounded
    // by the deadline rather than by a tick count so a slow machine takes more
    // slices instead of one long block that freezes the page.
    let stepped = 0
    while (Date.now() < deadline && !run.done) {
      stepOnce(run)
      stepped++
    }
    setStatus(`tick ${run.tick} / ${total}`)
    if (stepped === 0) break
    await new Promise((r) => setTimeout(r, 0))
  }

  const metrics = measure(run)
  const cov = coverageOf(run)

  const report = buildReport({
    runId: `seed-${seed}`,
    tick: run.tick,
    simSeconds: run.tick / 10,
    candidates: run.candidates,
    truth: run.truth,
    rooms: house.rooms,
    coverage: [
      {
        manifold: 'ground',
        fraction: cov.observedFraction,
        observedCells: cov.observedCells,
        totalCells: cov.totalCells,
      },
    ],
    regionCoverage: house.rooms.map((r) => ({
      roomId: r.id,
      roomName: r.name,
      // Per-room coverage, computed from the cells actually inside the room. Using
      // the global figure for every room would make the withheld-claims rule
      // vacuous, which is exactly the failure §8.2 rule 2 exists to prevent.
      fraction: roomCoverage(run, r.aabb),
    })),
    restrictToManifold: 'ground',
  })

  currentRun = run
  currentReport = report
  viewer.setFrame(frameFromRun(run, report, { includeTruth: viewer.layers.truth === true }))
  setStatus(`done — tick ${run.tick}, coverage ${(metrics.coverageFraction * 100).toFixed(2)}%`)
  redrawPanel()
  running = false
}

function stepOnce(run: SimRun): void {
  step(run)
}

function coverageOf(run: SimRun) {
  return coverage(run.grid, run.mask, 2)
}

function roomCoverage(run: SimRun, aabb: {
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

function redrawPanel(): void {
  if (currentRun === null || currentReport === null) return
  const regret = allocationRegret(currentRun.regretSamples)
  const agents = currentRun.agents.map((a) => {
    // A crawler's pose is (conduit, arc), not (x, z). Casting it and calling
    // toFixed prints "undefined" for a bot that is working perfectly, which is the
    // viewer lying about the constrained manifold rather than omitting it.
    const where = isLumenPose(a.pose)
      ? a.pose.conduitId === ''
        ? 'at port'
        : `${a.pose.conduitId} @ ${a.pose.arc.toFixed(2)} m`
      : `(${(a.pose as { x: number; z: number }).x.toFixed(2)}, ${(a.pose as { x: number; z: number }).z.toFixed(2)})`
    return (
      `${a.spec.id} · ${where} · battery ${(a.battery * 100).toFixed(0)}%` +
      `${a.currentJobId === null ? ' · idle' : ` · ${a.currentJobId}`}`
    )
  })

  const market = [
    `announced ${currentRun.jobTally.announced ?? 0} · done ${currentRun.jobTally.done ?? 0} · starved ${currentRun.jobTally.failed ?? 0}`,
    `regret mean ${(regret.mean * 100).toFixed(2)}% · p95 ${(regret.p95 * 100).toFixed(2)}% · n=${regret.samples}`,
    // Evaluability is a property of the *awards*, not of the roster. The first cut
    // tested `agents.length < 2`, which was right with one bot and became wrong at
    // Stage E: two agents on two manifolds never compete, so regret read 0.00% and
    // the panel would have printed "delete the auction" on the strength of an
    // experiment that had not run.
    `contested awards ${currentRun.contestedAwards} · ${formatVerdict(auctionVerdict(regret, currentRun.contestedAwards))}`,
    `uncovered cells ${coverageGaps(currentRun).length} · log hash ${currentRun.log.hash()}`,
  ]

  panel.render(currentReport, {
    seed,
    noise,
    jobs,
    layers: viewer.layers as unknown as Record<string, boolean>,
    agentLines: agents,
    marketLines: market,
    truthOn: viewer.layers.truth,
  })
}

function setStatus(text: string): void {
  const el = document.getElementById('status')
  if (el !== null) el.textContent = text
}

void simulate()