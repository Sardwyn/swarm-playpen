/**
 * Browser entry point for the yacht domain scene.
 *
 * ## What this is
 *
 * The domain model, rendered. There is no swarm in it yet — the simulation still
 * runs on the house. What is here is the vessel, its void network, the access
 * points, and the reachability, which is the part of the product that decides
 * whether there is a product.
 *
 * The panel says so, in those words. A demo that implies more than it contains is
 * the thing this whole project is arguing against.
 *
 * ## The scene reads the same content the diagnostic reads
 *
 * `scripts/diag-yacht-form.ts` prints the ASCII inboard profile of exactly this
 * content, and the two must agree. If the scene and the diagnostic ever disagree,
 * one of them is lying, and the diagnostic is the one with the tests.
 */

import * as THREE from 'three'
import { yacht as model } from '../sim/world/yacht-content.ts'
import { profileArea, totalProfileArea, reachableProfileArea } from '../sim/world/yacht.ts'
import { buildYachtScene } from './yacht-scene.ts'
import { OrbitShim } from './viewer.ts'

const CUT_Z = 0.65

const stage = document.getElementById('stage')!
const side = document.getElementById('side')!

// ------------------------------------------------------------------ renderer
// `preserveDrawingBuffer` so the canvas can be read back — a demo that cannot
// produce a still is a demo you cannot put in a deck.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(stage.clientWidth, stage.clientHeight)
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0d1117)
scene.fog = new THREE.Fog(0x0d1117, 40, 130)

scene.add(new THREE.AmbientLight(0xffffff, 0.55))
const key = new THREE.DirectionalLight(0xc9d1d9, 0.8)
key.position.set(14, 20, 12)
scene.add(key)
const rim = new THREE.DirectionalLight(0x4fd1c5, 0.4)
rim.position.set(-16, 7, -14)
scene.add(rim)

// A warm light in the engine room, because the engine room is where the machine
// is and the machine is the only heat source in the boat.
const engine = new THREE.PointLight(0xed8936, 3.2, 12, 2)
engine.position.set(-5.4, 2.1, CUT_Z)
scene.add(engine)

const yacht = buildYachtScene(model, CUT_Z)
scene.add(yacht.group)

const camera = new THREE.PerspectiveCamera(
  45,
  stage.clientWidth / stage.clientHeight,
  0.05,
  400,
)
const orbit = new OrbitShim(camera, renderer.domElement)
orbit.target.set(-0.8, 1.4, 0)
orbit.yaw = -0.44
orbit.pitch = 0.13
orbit.distance = 22

// ---------------------------------------------------------------------- panel
const voidTotal = totalProfileArea(model.regions, 'void')
const voidPerson = reachableProfileArea(model.regions, 'void', model.personReachability)
const voidCrawler = reachableProfileArea(model.regions, 'void', model.crawlerReachability)

function row(a: string, b: string, cls = ''): string {
  return `<tr class="${cls}"><td>${a}</td><td class="det">${b}</td></tr>`
}

side.innerHTML = `
  <h2>${model.id}</h2>
  <p class="sub">Domain model, rendered. No swarm yet — the simulation still runs on the house.</p>

  <h3>Principal</h3>
  <table>
    ${row('Length overall', `${model.principal.loa.toFixed(2)} m`)}
    ${row('Beam', `${model.principal.beam.toFixed(2)} m`)}
    ${row('Draft', `${model.principal.draft.toFixed(2)} m`)}
    ${row('Displacement', `${model.principal.displacementKg.toLocaleString()} kg`)}
    ${row('Source', model.principal.source)}
  </table>

  <h3>Voids</h3>
  <table>
    ${row('Total profile area', `${voidTotal.toFixed(1)} m²`)}
    ${row('Reachable by a person', `${voidPerson.toFixed(1)} m² (${((voidPerson / voidTotal) * 100).toFixed(0)}%)`, voidPerson === voidTotal ? 'ok' : 'warn')}
    ${row('Reachable by the crawler', `${voidCrawler.toFixed(1)} m² (${((voidCrawler / voidTotal) * 100).toFixed(0)}%)`, voidCrawler === voidTotal ? 'ok' : 'warn')}
    ${row('Reachable by neither', `${(voidTotal - Math.max(voidPerson, voidCrawler)).toFixed(1)} m²`, 'warn')}
    ${row('Crawler diameter', `${model.crawlerDiameterMm} mm`)}
  </table>

  <h3>Regions</h3>
  <table>
    ${model.regions
      .map((r) => {
        const person = model.personReachability.has(r.id)
        const crawler = model.crawlerReachability.has(r.id)
        const cls = r.kind === 'void' && !person ? 'warn' : r.kind === 'void' ? 'ok' : 'muted'
        return row(
          r.name,
          `${profileArea(r).toFixed(1)} m² — person ${person ? 'yes' : 'NO'}, crawler ${crawler ? 'yes' : 'NO'}`,
          cls,
        )
      })
      .join('')}
  </table>

  <h3>Faults</h3>
  <table>
    ${model.faults
      .map((f) => {
        const person = model.personReachability.has(f.region)
        return row(f.class, `${f.region}${person ? '' : ' — UNREACHABLE'}`, person ? '' : 'warn')
      })
      .join('')}
  </table>

  <h3>Assumptions</h3>
  <p class="sub warn">None of the above is a measurement. Principal characteristics are Sunseeker's published figures; every profile, bulkhead, deck height, hatch and void width is assumed.</p>
  <ul>${model.assumptions.map((a) => `<li class="det">${a}</li>`).join('')}</ul>

  <h3>Cut plane</h3>
  <p class="sub">z = ${CUT_Z.toFixed(2)} m, starboard of centreline, through the centre of a stringer void. A centreline cut misses every void, and the voids are the subject.</p>
`

// A handle on the scene, for the console and for automated inspection. A demo you
// cannot interrogate is a demo you cannot debug.
Object.assign(window as unknown as Record<string, unknown>, {
  __yacht: { scene, yacht, renderer, camera, orbit, model },
})

// --------------------------------------------------------------------- loop
function resize(): void {
  camera.aspect = stage.clientWidth / stage.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(stage.clientWidth, stage.clientHeight)
}
window.addEventListener('resize', resize)

let raf = 0
function frame(): void {
  orbit.update()
  renderer.render(scene, camera)
  raf = requestAnimationFrame(frame)
}
frame()

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(raf)
  yacht.dispose()
  renderer.dispose()
})
