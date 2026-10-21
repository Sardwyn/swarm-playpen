/**
 * Browser entry point for the yacht domain: run the swarm on the boat, record the
 * run, and play it back on a scripted camera.
 *
 * ## The camera is a piece of the argument
 *
 * A free orbit shows you the boat. The scripted sequence shows you the *problem*:
 * it starts outside in the dark, goes in to the engine room where the swarm is
 * working and the light is building, pulls forward along the hull to the stringer
 * void — which stays black the whole way — puts a person in it, and then pulls back
 * to the hero frame with the lit engine room behind the dark void.
 *
 * Any drag hands control back to the user; the button puts the camera back on rails.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

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
  marineTaxonomy,
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
const FRAMES_PER_SECOND = 14

const stage = document.getElementById('stage')!
const side = document.getElementById('side')!
const boot = document.getElementById('boot')!
const bootBar = document.getElementById('bootbar')!
const bootNote = document.getElementById('bootnote')!

// ------------------------------------------------------------------ the run
// The simulation is 3000 ticks of three agents, and it is computed before anything
// can be drawn. So it is computed in chunks, with a progress bar, rather than
// freezing the page.
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

async function compute(): Promise<void> {
  while (run.tick < TOTAL_TICKS && !run.done) {
    for (let i = 0; i < 50 && run.tick < TOTAL_TICKS && !run.done; i++) {
      step(run)
      recorder.record(run)
    }
    const pct = Math.round((run.tick / TOTAL_TICKS) * 100)
    bootBar.style.width = `${pct}%`
    bootNote.textContent = `tick ${run.tick} of ${TOTAL_TICKS}`
    await new Promise((r) => setTimeout(r, 0))
  }
}

const finalReport = buildReport({
  runId: `yacht-${yachtHouse.id}-seed-${SEED}`,
  tick: run.tick,
  simSeconds: run.tick / 10,
  candidates: run.candidates,
  truth: run.truth,
  rooms: yachtHouse.rooms,
  coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
  regionCoverage: [],
})
const take = recorder.finish(run, finalReport)

// The spaces: the ground-manifold rooms and the volumetric ones, from the same
// content file the simulator read.
const spaces: SpaceDef[] = [
  ...yachtHouse.rooms.map((r) => ({ id: r.id, name: r.name, aabb: r.aabb, kind: 'room' as const })),
  ...yachtHouse.voids.map((v) => ({ id: v.id, name: v.name, aabb: v.aabb, kind: 'void' as const })),
]

const manifoldAgents = new Map<string, string[]>()
for (const a of run.agents) {
  manifoldAgents.set(a.manifold, [...(manifoldAgents.get(a.manifold) ?? []), `${a.spec.id} (${a.spec.cls})`])
}

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(stage.clientWidth, stage.clientHeight)
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x07090c)
scene.fog = new THREE.Fog(0x07090c, 55, 190)
scene.add(new THREE.AmbientLight(0xffffff, 0.4))
const key = new THREE.DirectionalLight(0xc9d1d9, 0.7)
key.position.set(16, 22, 14)
scene.add(key)
const rim = new THREE.DirectionalLight(0x4fd1c5, 0.5)
rim.position.set(-18, 8, -16)
scene.add(rim)
const engineLight = new THREE.PointLight(0xffb454, 3.4, 12, 2)
engineLight.position.set(-5.4, 0.6, CUT_Z)
scene.add(engineLight)

const yacht = buildYachtScene({ form: yachtForm, spaces, cutZ: CUT_Z })
scene.add(yacht.group)

const camera = new THREE.PerspectiveCamera(40, stage.clientWidth / stage.clientHeight, 0.05, 500)
const orbit = new OrbitShim(camera, renderer.domElement)
orbit.target.set(0, 1.5, 0)
orbit.yaw = 1.15
orbit.pitch = 0.2
orbit.distance = 23

// The composer. Bloom is what turns a field of points into light.
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(
  new THREE.Vector2(stage.clientWidth, stage.clientHeight),
  0.55,
  0.45,
  0.32,
)
composer.addPass(bloom)
composer.addPass(new OutputPass())

// ----------------------------------------------------------------- camera cut
/**
 * The scripted camera.
 *
 * Six beats, and the third is the one that matters: the pull-forward along the
 * hull, where the lit engine room recedes and the stringer void does not light up.
 */
type Beat = {
  readonly t: number
  readonly target: readonly [number, number, number]
  readonly yaw: number
  readonly pitch: number
  readonly distance: number
}

const CUT: readonly Beat[] = [
  // 0. Outside, high, the whole boat in the dark.
  { t: 0.0, target: [0, 1.6, 0], yaw: 1.25, pitch: 0.3, distance: 27 },
  // 1. Down and inboard, towards the engine room.
  { t: 0.16, target: [-4.2, 0.7, 0], yaw: 1.05, pitch: 0.18, distance: 15 },
  // 2. Inside the engine room, low, the light building.
  { t: 0.34, target: [-6.0, 0.5, 0], yaw: 1.5, pitch: 0.13, distance: 9.5 },
  // 3. Pull forward along the hull. The void does not light up.
  { t: 0.54, target: [0.5, 0.7, 0], yaw: 1.35, pitch: 0.2, distance: 15 },
  // 4. In on the void, where the person is.
  { t: 0.72, target: [3.6, 0.7, CUT_Z], yaw: 1.7, pitch: 0.14, distance: 9 },
  // 5. The hero frame: lit engine room behind the dark void.
  { t: 0.9, target: [-1.0, 1.1, 0], yaw: 1.0, pitch: 0.24, distance: 22 },
  { t: 1.0, target: [0, 1.6, 0], yaw: 1.25, pitch: 0.3, distance: 27 },
]

function cameraAt(t: number): void {
  for (let i = 0; i < CUT.length - 1; i++) {
    const a = CUT[i]!
    const b = CUT[i + 1]!
    if (t < a.t || t > b.t) continue
    const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
    // Smoothstep, so the move eases rather than snapping between keys.
    const e = f * f * (3 - 2 * f)
    orbit.target.set(
      a.target[0] + (b.target[0] - a.target[0]) * e,
      a.target[1] + (b.target[1] - a.target[1]) * e,
      a.target[2] + (b.target[2] - a.target[2]) * e,
    )
    orbit.yaw = a.yaw + (b.yaw - a.yaw) * e
    orbit.pitch = a.pitch + (b.pitch - a.pitch) * e
    orbit.distance = a.distance + (b.distance - a.distance) * e
    return
  }
}

// ----------------------------------------------------------------- playback
let frameIndex = 0
let playing = true
let cinematic = true
let lastTime = 0

const scrubber = document.getElementById('scrub') as HTMLInputElement | null
const playButton = document.getElementById('play') as HTMLButtonElement | null
const cutButton = document.getElementById('cut') as HTMLButtonElement | null
const tickLabel = document.getElementById('tick') as HTMLElement | null
const coverageLabel = document.getElementById('coverage') as HTMLElement | null
const hudCoverage = document.getElementById('hud-coverage') as HTMLElement | null
const hudFound = document.getElementById('hud-found') as HTMLElement | null
const hudMiss = document.getElementById('hud-miss') as HTMLElement | null

function showFrame(index: number): void {
  frameIndex = Math.max(0, Math.min(take.frames.length - 1, index))
  const frame = frameFromTake(take, frameIndex)
  yacht.setFrame(frame)
  if (scrubber !== null) scrubber.value = String(frameIndex)
  if (tickLabel !== null) {
    tickLabel.textContent = `tick ${frame.tick} / ${run.tick}`
  }
  const pct = observedFraction(take, frameIndex) * 100
  if (coverageLabel !== null) coverageLabel.textContent = `boat coverage ${pct.toFixed(1)}%`
  const roomPct = regionCoverage(take, frameIndex, yachtHouse.rooms[0]!.aabb) * 100
  if (hudCoverage !== null) hudCoverage.textContent = `${roomPct.toFixed(1)}%`
  updateVerdict(frame)
}

const verdictList = document.getElementById('verdict')!

function updateVerdict(frame: ReturnType<typeof frameFromTake>): void {
  const v = buildVerdict(frame.findings, yachtTruth, manifoldAgents)
  const found = v.filter((x) => x.found).length
  const arch = v.filter((x) => !x.found && x.kind === 'ARCHITECTURE').length
  if (hudFound !== null) hudFound.textContent = `${found} / ${v.length}`
  if (hudMiss !== null) hudMiss.textContent = String(arch)
  verdictList.innerHTML = v
    .map(
      (x) =>
        `<li class="${x.found ? 'ok' : x.kind === 'ARCHITECTURE' ? 'arch' : 'det'}">` +
        `<span class="vid">${x.id}</span>` +
        `<span class="vcls">${x.cls}</span>` +
        `<span class="vkind">${x.kind}</span>` +
        `</li>`,
    )
    .join('')
}

if (scrubber !== null) {
  scrubber.max = String(Math.max(0, take.frames.length - 1))
  scrubber.addEventListener('input', () => {
    playing = false
    cinematic = false
    if (playButton !== null) playButton.textContent = 'play'
    if (cutButton !== null) cutButton.classList.remove('on')
    showFrame(Number(scrubber.value))
  })
}
if (playButton !== null) {
  playButton.addEventListener('click', () => {
    playing = !playing
    playButton.textContent = playing ? 'pause' : 'play'
  })
}
if (cutButton !== null) {
  cutButton.addEventListener('click', () => {
    cinematic = !cinematic
    cutButton.classList.toggle('on', cinematic)
  })
  cutButton.classList.add('on')
}

// The user grabbing the mouse means they want to look around.
renderer.domElement.addEventListener('pointerdown', () => {
  cinematic = false
  cutButton?.classList.remove('on')
})

// -------------------------------------------------------------------- panel
function row(a: string, b: string, cls = ''): string {
  return `<tr class="${cls}"><td>${a}</td><td class="det">${b}</td></tr>`
}

const finalFindings = frameFromTake(take, take.frames.length - 1).findings
const finalVerdict = buildVerdict(finalFindings, yachtTruth, manifoldAgents)
const missed = finalVerdict.filter((v) => !v.found)

side.innerHTML = `
  <h2>${yachtHouse.name ?? yachtHouse.id}</h2>
  <p class="sub">The swarm, run on the vessel, recorded and replayed. The log hash is the hash of the run.</p>

  <h3>Principal</h3>
  <table>
    ${row('Length overall', '17.14 m')}
    ${row('Beam', '4.93 m')}
    ${row('Draft', '1.48 m')}
    ${row('Source', 'Sunseeker Predator 55 published specification')}
  </table>

  <h3>The run</h3>
  <table>
    ${row('Ticks', String(run.tick))}
    ${row('Recorded frames', String(take.frames.length))}
    ${row('Log hash', take.logHash)}
    ${row('Findings', String(finalFindings.length))}
  </table>

  <h3>Why the misses</h3>
  ${
    missed.length === 0
      ? '<p class="sub">Nothing missed.</p>'
      : missed
          .map(
            (v) =>
              `<p class="miss ${v.kind === 'ARCHITECTURE' ? 'arch' : 'det'}">` +
              `<b>${v.id}</b> — ${v.cls}<br><span class="sig">${v.signature}</span><br>${v.detail}` +
              (v.reason === undefined ? '' : `<br>${v.reason}`) +
              `</p>`,
          )
          .join('')
  }

  <h3>Reading, or cause</h3>
  <p class="sub">The instrument produces a reading. A surveyor produces a cause. These are not the same claim, and the report never makes the second one.</p>
  <table>
    ${marineTaxonomy.signatures
      .map(
        (s) =>
          `<tr><td>${s.id}</td><td class="det">${s.causes.length} causes &middot; ${
            s.separable ? 'separable' : 'not separable'
          }</td></tr>`,
      )
      .join('')}
  </table>
  <p class="sub">A humidity anomaly of undetermined cause may be ${marineTaxonomy.signatures
    .find((s) => s.id === 'moisture_leak')!
    .causes.join(', ')
    .replace(/_/g, ' ')}. No single measurement separates them.</p>

  <h3>What the swarm cannot see</h3>
  ${marineTaxonomy.classes
    .filter((c) => c.observable === 'not_observable')
    .map(
      (c) =>
        `<p class="miss arch"><b>${c.docRef} ${c.name}</b><br>${c.note}</p>`,
    )
    .join('')}

  <h3>The apertures</h3>
  <table>
    ${row('Deck hatch clear width', '200 mm')}
    ${row('Ground bot', `340 mm across (r = ${GROUND_BOT.radius} m)`)}
    ${row('Hover bot', `240 mm span, needs 400 mm of clearance (r = ${HOVER.radius} m)`)}
    ${row('Inchworm', `80 mm, but confined to conduits`)}
    ${row('A person', '1.8 m, and can get through a 200 mm hatch')}
  </table>

  <h3>Assumptions</h3>
  <p class="sub warn">None of this is a measurement. The principal characteristics are Sunseeker's published figures; every profile, bulkhead, deck height, hatch size and pipe route is assumed.</p>
  <ul>${yachtAssumptions.map((a) => `<li class="det">${a}</li>`).join('')}</ul>
`

// --------------------------------------------------------------------- loop
function loop(now: number): void {
  const dt = lastTime === 0 ? 0 : (now - lastTime) / 1000
  lastTime = now
  if (playing) {
    const next = frameIndex + dt * FRAMES_PER_SECOND
    if (next >= take.frames.length - 1) {
      showFrame(0)
    } else {
      showFrame(Math.floor(next))
    }
  }
  if (cinematic) {
    cameraAt(frameIndex / Math.max(1, take.frames.length - 1))
  }
  orbit.update()
  composer.render()
  requestAnimationFrame(loop)
}

function resize(): void {
  camera.aspect = stage.clientWidth / stage.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(stage.clientWidth, stage.clientHeight)
  composer.setSize(stage.clientWidth, stage.clientHeight)
  bloom.resolution.set(stage.clientWidth, stage.clientHeight)
}
window.addEventListener('resize', resize)

Object.assign(window as unknown as Record<string, unknown>, {
  __yacht: { scene, yacht, renderer, camera, orbit, composer, take, run, showFrame, cameraAt },
})

void compute().then(() => {
  boot.classList.add('gone')
  showFrame(0)
  requestAnimationFrame(loop)
})
