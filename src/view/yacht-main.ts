/**
 * Browser entry point for the yacht domain: run the swarm on the boat, record the
 * run, and play it back.
 *
 * ## What is on screen
 *
 * The boat, cut open, with the swarm's coverage drawn into it, and the one space
 * the swarm could not reach drawn dark. The panel carries the numbers, the verdict
 * on every authored fault, and the list of assumptions the whole thing rests on.
 *
 * ## The replay is a recording, not a re-simulation
 *
 * The simulator is deterministic, so the run could be re-run to seek. But a scrubber
 * that stutters is a scrubber nobody drags, and the take is the run recorded once
 * with its coverage delta-encoded. The log hash in the take header is the hash of
 * the run that produced it, which is the only claim worth making about a replay.
 */

import * as THREE from 'three'
import { createRun, defaultConfig, step } from '../sim/sim/run.ts'
import { buildReport } from '../sim/report/report.ts'
import { TakeRecorder, frameFromTake, observedFraction, regionCoverage } from '../sim/report/take.ts'
import { buildVerdict } from '../sim/report/verdict.ts'
import { GROUND_BOT } from '../sim/sim/agents.ts'
import { HOVER, INCHWORM } from '../sim/types.ts'
import {
  yachtHouse,
  yachtTruth,
  yachtForm,
  yachtAssumptions,
  YACHT_SPAWN,
  YACHT_INCHWORM_HOME,
} from '../sim/world/yacht-sim.ts'
import { buildYachtScene } from './yacht-scene.ts'
import type { SpaceDef } from './yacht-scene.ts'
import { OrbitShim } from './viewer.ts'

const CUT_Z = 0.65
const SEED = 1
const NOISE = 1
const MISSION_SECONDS = 300
const TOTAL_TICKS = 3000
const EVERY_N_TICKS = 10

// ------------------------------------------------------------------ the run
const run = createRun(
  yachtHouse,
  defaultConfig({
    seed: SEED,
    noiseMultiplier: NOISE,
    missionSeconds: MISSION_SECONDS,
    agents: [GROUND_BOT, INCHWORM, HOVER],
    inchwormHomePort: YACHT_INCHWORM_HOME,
  }),
  YACHT_SPAWN,
  yachtTruth,
)

const recorder = new TakeRecorder({
  contentId: yachtHouse.id,
  truth: yachtTruth,
  everyNTicks: EVERY_N_TICKS,
})

while (run.tick < TOTAL_TICKS && !run.done) {
  step(run)
  recorder.record(run)
}

const finalReport = buildReport({
  runId: `yacht-${yachtHouse.id}-seed-${SEED}`,
  tick: run.tick,
  simSeconds: run.tick / 10,
  candidates: run.candidates,
  truth: run.truth,
  rooms: yachtHouse.rooms,
  coverage: [
    {
      manifold: 'ground',
      fraction: 0,
      observedCells: 0,
      totalCells: 0,
    },
  ],
  regionCoverage: [],
})
const take = recorder.finish(run, finalReport)

// The spaces: the ground-manifold rooms and the volumetric ones, from the same
// content file the simulator read.
const spaces: SpaceDef[] = [
  ...yachtHouse.rooms.map((r) => ({ id: r.id, name: r.name, aabb: r.aabb, kind: 'room' as const })),
  ...yachtHouse.voids.map((v) => ({ id: v.id, name: v.name, aabb: v.aabb, kind: 'void' as const })),
]

// Which agents live on which manifold, for the verdict's classification.
const manifoldAgents = new Map<string, string[]>()
for (const a of run.agents) {
  const list = manifoldAgents.get(a.manifold) ?? []
  list.push(`${a.spec.id} (${a.spec.cls})`)
  manifoldAgents.set(a.manifold, list)
}

// ------------------------------------------------------------------ renderer
const stage = document.getElementById('stage')!
const side = document.getElementById('side')!

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(stage.clientWidth, stage.clientHeight)
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0d1117)
scene.fog = new THREE.Fog(0x0d1117, 60, 220)
scene.add(new THREE.AmbientLight(0xffffff, 0.55))
const key = new THREE.DirectionalLight(0xc9d1d9, 0.8)
key.position.set(14, 20, 12)
scene.add(key)
const rim = new THREE.DirectionalLight(0x4fd1c5, 0.4)
rim.position.set(-16, 7, -14)
scene.add(rim)
const engineLight = new THREE.PointLight(0xed8936, 3.2, 12, 2)
engineLight.position.set(-5.4, 0.4, CUT_Z)
scene.add(engineLight)

const yacht = buildYachtScene({ form: yachtForm, spaces, cutZ: CUT_Z })
scene.add(yacht.group)

const camera = new THREE.PerspectiveCamera(45, stage.clientWidth / stage.clientHeight, 0.05, 400)
const orbit = new OrbitShim(camera, renderer.domElement)
orbit.target.set(0, 1.5, 0)
orbit.yaw = 1.15
orbit.pitch = 0.2
orbit.distance = 23

// ----------------------------------------------------------------- playback
let frameIndex = 0
let playing = true
let lastTime = 0
let framesPerSecond = 12

const scrubber = document.getElementById('scrub') as HTMLInputElement | null
const playButton = document.getElementById('play') as HTMLButtonElement | null
const tickLabel = document.getElementById('tick') as HTMLElement | null
const coverageLabel = document.getElementById('coverage') as HTMLElement | null

function showFrame(index: number): void {
  frameIndex = Math.max(0, Math.min(take.frames.length - 1, index))
  const frame = frameFromTake(take, frameIndex)
  yacht.setFrame(frame)
  if (scrubber !== null) scrubber.value = String(frameIndex)
  if (tickLabel !== null) {
    tickLabel.textContent = `tick ${frame.tick} / ${run.tick}  ·  t+${frame.simSeconds.toFixed(1)} s`
  }
  if (coverageLabel !== null) {
    const pct = observedFraction(take, frameIndex) * 100
    coverageLabel.textContent = `ground coverage ${pct.toFixed(1)}%`
  }
  updatePanel()
}

if (scrubber !== null) {
  scrubber.max = String(Math.max(0, take.frames.length - 1))
  scrubber.addEventListener('input', () => {
    playing = false
    if (playButton !== null) playButton.textContent = '▶ play'
    showFrame(Number(scrubber.value))
  })
}
if (playButton !== null) {
  playButton.addEventListener('click', () => {
    playing = !playing
    playButton.textContent = playing ? '❚❚ pause' : '▶ play'
  })
}

function loop(now: number): void {
  const dt = lastTime === 0 ? 0 : (now - lastTime) / 1000
  lastTime = now
  if (playing) {
    const next = frameIndex + dt * framesPerSecond
    if (next >= take.frames.length - 1) {
      showFrame(0)
    } else {
      showFrame(Math.floor(next))
    }
  }
  orbit.update()
  renderer.render(scene, camera)
  requestAnimationFrame(loop)
}

// -------------------------------------------------------------------- panel
function row(a: string, b: string, cls = ''): string {
  return `<tr class="${cls}"><td>${a}</td><td class="det">${b}</td></tr>`
}

const finalFindings = frameFromTake(take, take.frames.length - 1).findings
const verdict = buildVerdict(finalFindings, yachtTruth, manifoldAgents)
const missed = verdict.filter((v) => !v.found)
const architectural = missed.filter((v) => v.kind === 'ARCHITECTURE')

function updatePanel(): void {
  const frame = frameFromTake(take, frameIndex)
  const live = buildVerdict(frame.findings, yachtTruth, manifoldAgents)
  const liveMissed = live.filter((v) => !v.found)

  side.innerHTML = `
    <h2>${yachtHouse.name ?? yachtHouse.id}</h2>
    <p class="sub">The swarm, run on the vessel. Recorded and replayed; the log hash is the hash of the run.</p>

    <h3>Principal</h3>
    <table>
      ${row('Length overall', '17.14 m')}
      ${row('Beam', '4.93 m')}
      ${row('Draft', '1.48 m')}
      ${row('Source', 'Sunseeker Predator 55 published specification')}
    </table>

    <h3>This frame</h3>
    <table>
      ${row('Tick', `${frame.tick}`)}
      ${row('Engine room coverage', `${(regionCoverage(take, frameIndex, yachtHouse.rooms[0]!.aabb) * 100).toFixed(1)}%`)}
      ${row('Whole-boat coverage', `${(observedFraction(take, frameIndex) * 100).toFixed(1)}%`)}
      ${row('Findings', String(frame.findings.length))}
      ${row('Log hash', take.logHash)}
      ${row('Recorded frames', String(take.frames.length))}
    </table>

    <h3>The verdict</h3>
    <table>
      ${live
        .map(
          (v) =>
            row(
              `${v.id} · ${v.cls}`,
              `sev ${v.severity.toFixed(2)} · ${v.kind}`,
              v.found ? 'ok' : v.kind === 'ARCHITECTURE' ? 'warn' : 'muted',
            ),
        )
        .join('')}
    </table>

    <h3>Why the misses</h3>
    ${
      liveMissed.length === 0
        ? '<p class="sub">Nothing missed in this frame.</p>'
        : liveMissed
            .map(
              (v) =>
                `<p class="sub ${v.kind === 'ARCHITECTURE' ? 'warn' : 'muted'}">` +
                `<b>${v.id}</b> — ${v.kind}<br>${v.detail}` +
                (v.reason === undefined ? '' : `<br>${v.reason}`) +
                `</p>`,
            )
            .join('')
    }

    <h3>The apertures</h3>
    <table>
      ${row('Deck hatch clear width', '200 mm')}
      ${row('Ground bot', `340 mm across (r = ${GROUND_BOT.radius} m)`)}
      ${row('Hover bot', `240 mm span, needs 400 mm of clearance (r = ${HOVER.radius} m)`)}
      ${row('Inchworm', `80 mm, but confined to conduits`)}
      ${row('A person', 'can get through a 200 mm hatch')}
      ${row('Architectural misses', String(architectural.length), architectural.length > 0 ? 'warn' : 'ok')}
    </table>

    <h3>Assumptions</h3>
    <p class="sub warn">None of this is a measurement. The principal characteristics are Sunseeker's published figures; every profile, bulkhead, deck height, hatch size and pipe route is assumed.</p>
    <ul>${yachtAssumptions.map((a) => `<li class="det">${a}</li>`).join('')}</ul>
  `
}

showFrame(0)
requestAnimationFrame(loop)

window.addEventListener('resize', () => {
  camera.aspect = stage.clientWidth / stage.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(stage.clientWidth, stage.clientHeight)
})

Object.assign(window as unknown as Record<string, unknown>, {
  __yacht: { scene, yacht, renderer, camera, orbit, take, run, showFrame },
})
