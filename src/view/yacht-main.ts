/**
 * Browser entry point for the yacht domain: run the swarm on the boat, record
 * the run, and play it back on a directed camera with a live console.
 *
 * ## The three things this does
 *
 * 1. **Runs it.** 3000 ticks of three agents, computed in chunks so the page
 *    paints a progress bar rather than freezing.
 * 2. **Records it.** Every three ticks, so the take has a thousand frames and
 *    the playback has something to interpolate between.
 * 3. **Plays it back on rails.** A camera director with shots that lock onto
 *    each machine in turn, a console reading out the telemetry live, and a
 *    playhead that moves **continuously** — because the camera used to be
 *    driven by an integer frame index, and everything juddered at the record
 *    rate.
 *
 * ## The readout does not depend on the picture
 *
 * The three-dimensional view is one view of the run. The readout is the run.
 * So the console, the transport, the event stream and the report are built
 * and driven whether or not the machine can give us a WebGL context, and the
 * 3-D is the part that is allowed to fail. A viewer that cannot open a context
 * still gets the telemetry, the findings and the coverage; it just does not
 * get a picture of them.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

import { createRun, defaultConfig, step } from '../sim/sim/run.ts'
import { buildReport } from '../sim/report/report.ts'
import { TakeRecorder, frameAt, regionCoverage } from '../sim/report/take.ts'
import { buildVerdict } from '../sim/report/verdict.ts'
import { GROUND_BOT } from '../sim/sim/agents.ts'
import { HOVER, HOVER_CLEARANCE_M, INCHWORM } from '../sim/types.ts'
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
import { buildConsole } from './yacht-console.ts'
import { CameraDirector } from './yacht-director.ts'
import { OrbitShim } from './viewer.ts'

const CUT_Z = 0.65
const SEED = 1
const NOISE = 1
const MISSION_SECONDS = 300
const TOTAL_TICKS = 3000
const EVERY_N_TICKS = 3
/** Wall-clock seconds for the whole run. The take has ~1000 frames in it. */
const RUN_SECONDS = 34

const stage = document.getElementById('stage')!
const side = document.getElementById('side')!
const boot = document.getElementById('boot')!
const bootBar = document.getElementById('bootbar')!
const bootNote = document.getElementById('bootnote')!

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

let take!: ReturnType<typeof recorder.finish>
let finalReport!: ReturnType<typeof buildReport>

function finishTheRun(): void {
  finalReport = buildReport({
    runId: `yacht-${yachtHouse.id}-seed-${SEED}`,
    tick: run.tick,
    simSeconds: run.tick / 10,
    candidates: run.candidates,
    truth: run.truth,
    rooms: yachtHouse.rooms,
    coverage: [{ manifold: 'ground', fraction: 0, observedCells: 0, totalCells: 0 }],
    regionCoverage: [],
  })
  take = recorder.finish(run, finalReport)
}

const spaces: SpaceDef[] = [
  ...yachtHouse.rooms.map((r) => ({ id: r.id, name: r.name, aabb: r.aabb, kind: 'room' as const })),
  ...yachtHouse.voids.map((v) => ({ id: v.id, name: v.name, aabb: v.aabb, kind: 'void' as const })),
]

const manifoldAgents = new Map<string, string[]>()
for (const a of run.agents) {
  manifoldAgents.set(a.manifold, [...(manifoldAgents.get(a.manifold) ?? []), `${a.spec.id} (${a.spec.cls})`])
}

// ------------------------------------------------------------------ the view
// Everything three-dimensional is optional. The readout is not.
let renderer: THREE.WebGLRenderer | null = null
let composer: EffectComposer | null = null
let bloom: UnrealBloomPass | null = null
let camera: THREE.PerspectiveCamera | null = null
let orbit: OrbitShim | null = null
let yacht: ReturnType<typeof buildYachtScene> | null = null

try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(stage.clientWidth, stage.clientHeight)
  stage.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x07090c)
  scene.fog = new THREE.Fog(0x07090c, 40, 150)
  scene.add(new THREE.AmbientLight(0xffffff, 0.35))
  const key = new THREE.DirectionalLight(0xc9d1d9, 0.6)
  key.position.set(16, 22, 14)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x4fd1c5, 0.6)
  rim.position.set(-18, 8, -16)
  scene.add(rim)
  const engineLight = new THREE.PointLight(0xffb454, 3.2, 10, 2)
  engineLight.position.set(-5.4, 0.6, CUT_Z)
  scene.add(engineLight)

  yacht = buildYachtScene({ form: yachtForm, spaces, cutZ: CUT_Z })
  scene.add(yacht.group)

  camera = new THREE.PerspectiveCamera(42, stage.clientWidth / stage.clientHeight, 0.03, 500)
  orbit = new OrbitShim(camera, renderer.domElement)
  orbit.target.set(0, 0.5, 0)
  orbit.yaw = 1.25
  orbit.pitch = 0.3
  orbit.distance = 22
  yacht.setCamera(camera)

  composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  bloom = new UnrealBloomPass(
    new THREE.Vector2(stage.clientWidth, stage.clientHeight),
    0.72,
    0.5,
    0.22,
  )
  composer.addPass(bloom)
  composer.addPass(new OutputPass())
} catch (err) {
  // The console still runs. Say so, and carry on.
  console.warn('3-D view unavailable:', err)
  stage.innerHTML =
    '<div id="nogpu"><b>3-D VIEW UNAVAILABLE</b><span>This machine would not give us a WebGL context. The readout is live and complete.</span></div>'
  document.getElementById('console')!.classList.add('flat')
}

// ----------------------------------------------------------------- playback
let playhead = 0
let playing = true
let cinematic = true
let speed = 1
let lastTime = 0
let lastFrameIndex = -1
const director = new CameraDirector()

const scrubber = document.getElementById('c-scrub') as HTMLInputElement | null
const playButton = document.getElementById('c-play') as HTMLButtonElement | null
const cutButton = document.getElementById('c-shot') as HTMLButtonElement | null
const speedButton = document.getElementById('c-speed') as HTMLButtonElement | null
const shotName = document.getElementById('c-shotname')
const capShot = document.getElementById('cap-shot')
const capLine = document.getElementById('cap-line')
const capLive = document.getElementById('cap-live')
const reportButton = document.getElementById('c-report') as HTMLButtonElement | null
if (reportButton !== null) {
  reportButton.addEventListener('click', () => {
    side.classList.toggle('open')
    reportButton.classList.toggle('on', side.classList.contains('open'))
  })
}

// The screen-space lock-on tags. A marker in the world is either invisible or
// enormous; a marker in screen space is always exactly as big as it should be.
const tagLayer = document.getElementById('tags')!
const tags = new Map<string, HTMLElement>()
for (const id of ['ground-01', 'hover-01', 'inch-01']) {
  const tag = document.createElement('div')
  tag.className = 'lock'
  tag.innerHTML = `<b>${id}</b><span></span>`
  tagLayer.appendChild(tag)
  tags.set(id, tag)
}

const consoleRoot = document.getElementById('console')!
const consoleUi = buildConsole(consoleRoot, yachtHouse)

function showAt(index: number): void {
  playhead = Math.max(0, Math.min(take.frames.length - 1, index))
  const frame = frameAt(take, playhead)
  if (yacht !== null) yacht.setFrame(frame, performance.now() / 1000)
  const floor = Math.floor(playhead)
  if (floor !== lastFrameIndex) {
    lastFrameIndex = floor
    if (yacht !== null) yacht.setTrailPoints(frame)
  }
  consoleUi.update(frame, take, floor, take.frames.length)

  // The caption: what the viewer is being shown, and what the machine is
  // actually doing at that moment.
  const t = playhead / Math.max(1, take.frames.length - 1)
  const shot = director.shotAt(t)
  if (shotName !== null) shotName.textContent = shot.name
  if (capShot !== null) capShot.textContent = shot.name
  if (capLine !== null) capLine.textContent = shot.caption
  if (capLive !== null) {
    const subject = shot.follow === undefined ? undefined : frame.agents.find((a) => a.id === shot.follow)
    const others = frame.agents
      .filter((a) => a.id !== shot.follow)
      .map((a) => `${a.id} ${(a.battery * 100).toFixed(0)}%`)
      .join(' · ')
    const subjectTask =
      subject === undefined
        ? ''
        : subject.currentJobType !== null
          ? subject.currentJobType.replace(/_/g, ' ')
          : 'working'
    capLive.textContent =
      subject === undefined
        ? others
        : `${subject.id} · ${subjectTask} · ${(subject.battery * 100).toFixed(0)}% battery${others === '' ? '' : ` · ${others}`}`
  }
  updateTags(frame)
}

const projected = new THREE.Vector3()
function updateTags(frame: ReturnType<typeof frameAt>): void {
  if (camera === null) return
  for (const a of frame.agents) {
    const tag = tags.get(a.id)
    if (tag === undefined) continue
    projected.set(a.x, a.y + 0.2, a.z).project(camera)
    const behind = projected.z > 1
    const x = (projected.x * 0.5 + 0.5) * stage.clientWidth
    const y = (-projected.y * 0.5 + 0.5) * stage.clientHeight
    tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    tag.style.display = behind ? 'none' : 'flex'
    const span = tag.querySelector('span') as HTMLElement
    span.textContent = `${a.currentJobType !== null ? a.currentJobType.replace(/_/g, ' ') : 'idle'} · ${(
      a.battery * 100
    ).toFixed(0)}%`
    if (a.faulted) tag.classList.add('bad')
    else tag.classList.remove('bad')
  }
}

if (scrubber !== null) {
  scrubber.addEventListener('input', () => {
    playing = false
    cinematic = false
    if (playButton !== null) playButton.textContent = 'PLAY'
    if (cutButton !== null) cutButton.classList.remove('on')
    showAt(Number(scrubber.value))
  })
}
if (playButton !== null) {
  playButton.addEventListener('click', () => {
    playing = !playing
    playButton.textContent = playing ? 'PAUSE' : 'PLAY'
  })
}
if (cutButton !== null) {
  cutButton.addEventListener('click', () => {
    cinematic = !cinematic
    cutButton.classList.toggle('on', cinematic)
  })
}
if (speedButton !== null) {
  speedButton.addEventListener('click', () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1
    speedButton.textContent = `${speed.toFixed(1)}×`
  })
}
renderer?.domElement.addEventListener('pointerdown', () => {
  cinematic = false
  cutButton?.classList.remove('on')
})

// -------------------------------------------------------------------- report
function row(a: string, b: string): string {
  return `<tr><td>${a}</td><td class="det">${b}</td></tr>`
}

function renderPanel(): void {
  const finalFindings = finalReport.findings
  const finalVerdict = buildVerdict(finalFindings, yachtTruth, manifoldAgents)
  const missed = finalVerdict.filter((v) => !v.found)
  const roomPct = (regionCoverage(take, take.frames.length - 1, yachtHouse.rooms[0]!.aabb) * 100).toFixed(1)

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
    ${row('Engine room coverage', `${roomPct}%`)}
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

  <h3>What the swarm cannot see</h3>
  ${marineTaxonomy.classes
    .filter((c) => c.observable === 'not_observable')
    .map((c) => `<p class="miss arch"><b>${c.docRef} ${c.name}</b><br>${c.note}</p>`)
    .join('')}

  <h3>The apertures</h3>
  <table>
    ${row('Deck hatch clear width', '200 mm')}
    ${row('Ground bot', `340 mm across (r = ${GROUND_BOT.radius} m)`)}
    ${row('Hover bot', `240 mm across (r = ${HOVER.radius} m); 0.40 m of passage, ${HOVER_CLEARANCE_M} m of ceiling`)}
    ${row('Inchworm', `80 mm, but confined to conduits`)}
    ${row('A person', '1.8 m. An arm and a torch go through 200 mm; a body does not.')}
  </table>

  <h3>Assumptions</h3>
  <p class="sub warn">None of this is a measurement. The principal characteristics are Sunseeker's published figures; every profile, bulkhead, deck height, hatch size and pipe route is assumed.</p>
  <ul>${yachtAssumptions.map((a) => `<li class="det">${a}</li>`).join('')}</ul>
`
}

// --------------------------------------------------------------------- loop
function loop(now: number): void {
  const dt = lastTime === 0 ? 0 : (now - lastTime) / 1000
  lastTime = now

  if (playing && take !== undefined) {
    const framesPerSecond = (take.frames.length - 1) / RUN_SECONDS
    let next = playhead + dt * framesPerSecond * speed
    if (next >= take.frames.length - 1) next = 0
    showAt(next)
  }

  if (cinematic && take !== undefined && orbit !== null && camera !== null) {
    const t = playhead / Math.max(1, take.frames.length - 1)
    const state = director.at(t, (x) => frameAt(take, x * (take.frames.length - 1)))
    orbit.target.set(state.targetX, state.targetY, state.targetZ)
    orbit.yaw = state.yaw
    orbit.pitch = state.pitch
    orbit.distance = state.distance
    if (Math.abs(camera.fov - state.fov) > 0.01) {
      camera.fov = state.fov
      camera.updateProjectionMatrix()
    }
  }

  orbit?.update()
  composer?.render()
  requestAnimationFrame(loop)
}

function resize(): void {
  if (camera !== null) {
    camera.aspect = stage.clientWidth / stage.clientHeight
    camera.updateProjectionMatrix()
  }
  renderer?.setSize(stage.clientWidth, stage.clientHeight)
  composer?.setSize(stage.clientWidth, stage.clientHeight)
  bloom?.resolution.set(stage.clientWidth, stage.clientHeight)
}
window.addEventListener('resize', resize)

Object.assign(window as unknown as Record<string, unknown>, {
  __yacht: {
    run,
    director,
    showAt,
    get take() {
      return take
    },
    get scene() {
      return yacht?.group
    },
  },
})

void compute().then(() => {
  finishTheRun()
  renderPanel()
  boot.classList.add('gone')
  showAt(0)
  requestAnimationFrame(loop)
})
