/**
 * The yacht scene.
 *
 * ## What this draws
 *
 * The boat, cut open, with its void network glowing inside it.
 *
 * The hull is drawn translucent on purpose. The subject of this project is what
 * is inside the boat and what cannot be reached, and an opaque hull hides exactly
 * that. So the boat is a ghost, the voids are volumes of light, and the access
 * points are bright rings.
 *
 * The picture is the argument, and the argument is three claims:
 *
 * 1. **The voids are enormous.** A 17-metre boat is mostly empty enclosed space
 *    that nobody looks in.
 * 2. **Some of it is reachable and some is not, and the difference is a hatch.**
 *    A person's reach and a crawler's reach are different sets, and the difference
 *    is the product.
 * 3. **A fault in a void is invisible from the hull.** Every fault is drawn with
 *    a line dropped to the plating below it, because the hull-side reading is
 *    downstream of the void by weeks to months. That line is the whole reason to
 *    measure the void rather than the hull.
 *
 * ## Nothing here is a measurement
 *
 * The scene is built from `content/yacht-01.json`, which is Sunseeker's published
 * principal characteristics plus assumed profiles, and the panel says so in as
 * many words. A demo that hides its assumptions is a demo that teaches the wrong
 * thing.
 */

import * as THREE from 'three'
import type { YachtModel } from '../sim/world/yacht.ts'
import { buildHullGeometry, hullSurfaceBelow } from './hull.ts'

const COLOURS = {
  bg: 0x0d1117,
  hull: 0x1b2430,
  hullEdge: 0x30363d,
  plating: 0x39424f,
  profile: 0x8fa3b8,
  void: 0x4fd1c5,
  voidUnreachable: 0x8b949e,
  compartment: 0x63b3ed,
  hatch: 0x68d391,
  fault: 0xf6e05e,
  faultUnverified: 0xed8936,
  vapour: 0xfc8181,
  thermal: 0xed8936,
  water: 0x63b3ed,
  text: 0xc9d1d9,
  dim: 0x8b949e,
}

export type YachtScene = {
  readonly group: THREE.Group
  readonly cutZ: number
  readonly dispose: () => void
}

/** A canvas-texture label. Cheaper and sharper than a font loader. */
function makeLabel(text: string, colour: number, scale = 1): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = '500 34px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 18
  canvas.width = w
  canvas.height = 48
  const c = canvas.getContext('2d')!
  c.font = font
  c.fillStyle = `rgba(13,17,23,0.72)`
  c.fillRect(0, 0, w, 48)
  c.fillStyle = `#${colour.toString(16).padStart(6, '0')}`
  c.fillText(text, 9, 32)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
  )
  const aspect = w / 48
  sprite.scale.set(0.9 * aspect * scale, 0.9 * scale, 1)
  sprite.renderOrder = 10
  return sprite
}

/**
 * A box volume with bright edges. The house of every claim in the picture.
 *
 * The label is optional because a region gets one label, not two: a name and a
 * reachability state are one piece of information, and two overlapping labels
 * are worse than no label.
 */
function addVolume(
  group: THREE.Group,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  fill: number,
  opacity: number,
  edge: number,
): void {
  const w = x1 - x0
  const h = y1 - y0
  const d = z1 - z0
  const geometry = new THREE.BoxGeometry(w, h, d)
  geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: fill,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  group.add(mesh)

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: edge, transparent: true, opacity: 0.9 }),
  )
  group.add(edges)
}

/** A soft radial glow, so a marker reads as a light rather than a dot. */
function makeGlow(colour: number, size: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const c = canvas.getContext('2d')!
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64)
  const hex = `#${colour.toString(16).padStart(6, '0')}`
  g.addColorStop(0, `${hex}cc`)
  g.addColorStop(0.18, `${hex}55`)
  g.addColorStop(0.5, `${hex}12`)
  g.addColorStop(1, `${hex}00`)
  c.fillStyle = g
  c.fillRect(0, 0, 128, 128)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  sprite.scale.set(size, size, 1)
  sprite.renderOrder = 8
  return sprite
}

export function buildYachtScene(model: YachtModel, cutZ = 0.65): YachtScene {
  const group = new THREE.Group()
  const disposables: { dispose: () => void }[] = []

  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x)
    return x
  }

  // ---------------------------------------------------------------- the hull
  const hull = buildHullGeometry(model.form, cutZ)

  const shell = new THREE.Mesh(
    track(hull.shell),
    new THREE.MeshPhongMaterial({
      color: COLOURS.hull,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
      shininess: 60,
      specular: 0x4fd1c5,
    }),
  )
  group.add(shell)

  const hullWire = new THREE.LineSegments(
    track(new THREE.WireframeGeometry(hull.shell)),
    new THREE.LineBasicMaterial({ color: COLOURS.hullEdge, transparent: true, opacity: 0.14 }),
  )
  group.add(hullWire)

  // The plating section at the cut plane, and the line where it meets the hull.
  const ribbon = new THREE.Mesh(
    track(hull.profileRibbon),
    new THREE.MeshBasicMaterial({
      color: COLOURS.plating,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    }),
  )
  group.add(ribbon)

  group.add(
    new THREE.Line(
      track(hull.profileCurve),
      new THREE.LineBasicMaterial({ color: COLOURS.profile, transparent: true, opacity: 0.95 }),
    ),
  )
  group.add(
    new THREE.Line(
      track(hull.sheerLine),
      new THREE.LineBasicMaterial({ color: COLOURS.hullEdge, transparent: true, opacity: 0.5 }),
    ),
  )

  // ------------------------------------------------------------ the interiors
  const halfWidth = model.voidWidthM / 2

  for (const r of model.regions) {
    const person = model.personReachability.has(r.id)
    const crawler = model.crawlerReachability.has(r.id)
    const reachable = person || crawler

    if (r.kind === 'void') {
      // The void band sits on the cut plane, because the cut plane was chosen to
      // pass through the centre of a stringer void.
      addVolume(
        group,
        r.x0,
        r.x1,
        r.y0,
        r.y1,
        cutZ - halfWidth,
        cutZ + halfWidth,
        reachable ? COLOURS.void : COLOURS.voidUnreachable,
        reachable ? 0.2 : 0.08,
        reachable ? COLOURS.void : COLOURS.voidUnreachable,
      )
    } else {
      // Compartments are drawn full-beam, so the boat reads as a boat rather than
      // a diagram. The engine room is the one that matters.
      addVolume(
        group,
        r.x0,
        r.x1,
        r.y0,
        r.y1,
        -model.form.principal.beam / 2,
        cutZ,
        COLOURS.compartment,
        0.08,
        COLOURS.compartment,
      )
    }

    // One label per region, and only for the voids. The compartments are obvious
    // from the boxes and the panel lists them; three sets of overlapping labels is
    // less information than one.
    if (r.kind === 'void') {
      const tag = makeLabel(
        reachable ? r.name : `${r.name} — UNREACHABLE`,
        reachable ? COLOURS.void : COLOURS.voidUnreachable,
        0.46,
      )
      // Anchored at the aft end of the region, so a region label and a fault
      // label in the same space do not land on top of each other.
      tag.position.set(r.x0 + 0.9, r.y1 + 0.16, cutZ)
      group.add(tag)
    }
  }

  // -------------------------------------------------------------- the hatches
  for (const h of model.hatches) {
    const ring = new THREE.Mesh(
      track(new THREE.TorusGeometry(Math.max(0.12, h.clearWidthMm / 2000), 0.035, 8, 28)),
      new THREE.MeshBasicMaterial({ color: COLOURS.hatch, transparent: true, opacity: 0.95 }),
    )
    ring.position.set(h.x, h.y, cutZ)
    ring.rotation.x = Math.PI / 2
    group.add(ring)

    const target = model.regions.find((r) => r.id === h.leadsTo)
    if (target !== undefined) {
      // A line from the hatch to the volume it opens into: the route, drawn.
      const from = new THREE.Vector3(h.x, h.y, cutZ)
      const to = new THREE.Vector3(
        Math.min(Math.max(h.x, target.x0), target.x1),
        (target.y0 + target.y1) / 2,
        cutZ,
      )
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to])
      group.add(
        new THREE.Line(
          track(geometry),
          new THREE.LineBasicMaterial({
            color: COLOURS.hatch,
            transparent: true,
            opacity: 0.5,
            linewidth: 1,
          }),
        ),
      )
    }
  }

  // ---------------------------------------------------------------- the faults
  model.faults.forEach((f, index) => {
    const sphere = new THREE.Mesh(
      track(new THREE.SphereGeometry(0.19, 16, 12)),
      new THREE.MeshBasicMaterial({ color: COLOURS.fault, transparent: true, opacity: 0.95 }),
    )
    sphere.position.set(f.x, f.y, cutZ)
    group.add(sphere)

    // A glow, so a fault reads as a beacon in the dark rather than a dot.
    const glow = makeGlow(COLOURS.fault, 0.9)
    glow.position.set(f.x, f.y, cutZ)
    group.add(glow)

    // The drop line to the plating below. This is the claim: the hull reading is
    // downstream of the void, so measuring the void finds it first.
    const below = hullSurfaceBelow(model.form, f.x, cutZ)
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(f.x, f.y, cutZ),
      below,
    ])
    group.add(
      new THREE.Line(
        track(geometry),
        new THREE.LineBasicMaterial({ color: COLOURS.fault, transparent: true, opacity: 0.45 }),
      ),
    )

    // Labels are staggered by index. Four faults in one space, each with a label
    // at the same height, is four labels on top of each other.
    const tag = makeLabel(f.class, COLOURS.fault, 0.4)
    tag.position.set(f.x, f.y + 0.34 + index * 0.3, cutZ)
    group.add(tag)
  })

  // -------------------------------------------------------------- the sources
  for (const s of model.sources) {
    const colour =
      s.kind === 'vapour' ? COLOURS.vapour : s.kind === 'thermal' ? COLOURS.thermal : COLOURS.water
    const marker = new THREE.Mesh(
      track(new THREE.OctahedronGeometry(0.1, 0)),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.9 }),
    )
    marker.position.set(s.x, s.y, cutZ)
    group.add(marker)
    // No text. Four sources in the engine room with four labels is four labels
    // stacked on one another; the legend says what the colours are, and the
    // sources are in the panel.
  }

  // ------------------------------------------------------------- the waterline
  const water = new THREE.Mesh(
    track(
      new THREE.PlaneGeometry(model.form.principal.loa, model.form.principal.beam).rotateX(
        -Math.PI / 2,
      ),
    ),
    new THREE.MeshBasicMaterial({
      color: 0x1f6feb,
      transparent: true,
      opacity: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  water.position.y = model.form.principal.draft
  group.add(water)

  return {
    group,
    cutZ,
    dispose: () => {
      for (const d of disposables) d.dispose()
      group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry !== undefined) mesh.geometry.dispose()
      })
    },
  }
}
