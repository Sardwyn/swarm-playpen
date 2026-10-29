/**
 * The engine room as a room, not a volume.
 *
 * ## Why this file exists
 *
 * The simulation stores the compartment as boxes: two engines, a gearbox, tanks,
 * a fuel header, shaft brackets, and the plating that closes the space. Drawn as
 * translucent AABBs those are a diagram. Drawn as masses — a block with a
 * cylinder bank, a painted tank, a lagged exhaust elbow, a fabricated bed on
 * rubber isolators — they are a room a person would recognise, and the rover's
 * path between them reads as work rather than as a line on a plan.
 *
 * ## What is drawn, and what is not
 *
 * Everything with a **position** is taken from the content file: the obstacles,
 * the conduits and the ports are the geometry the simulation itself uses, so the
 * picture and the model agree by construction. The one thing that is added is
 * **dressing** — stiffeners, frames, a drain grating, a label plate, a strip
 * light — and every piece of dressing is either flush with the sole or above
 * the height of the machinery, so that nothing in the picture is an obstacle
 * the simulation does not know about. A decorative crate standing on the sole
 * would be a lie the rover could be seen driving through.
 *
 * ## The cut
 *
 * The boat is cut open at one plane so the viewer can see in. Everything here
 * is cut at the same plane, and a solid that the cut passes through is given a
 * **section face** in a warmer colour, the way a sectional drawing marks the
 * place where the model was sliced. Without the section face a cut solid reads
 * as a short solid, and a cut engine reads as a small engine.
 *
 * ## The three pipe runs
 *
 * The three conduits in the content file are real: a 100 mm fuel line from the
 * tank to the engines, a coolant hose and a 180 mm exhaust run. The inchworm
 * crawls inside the fuel line, so the fuel line is drawn as a **cutaway** — a
 * translucent shell with a visible bore — because a crawler in an opaque pipe
 * is a crawler nobody can see, and a demo cannot show a thing it has hidden.
 */

import * as THREE from 'three'

export type Aabb = {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}

export type Fitting = {
  readonly id: string
  readonly material: string
  readonly aabb: Aabb
}

/** A declared conduit: the pipes the inchworm can crawl, and the runs beside them. */
export type PipeRun = {
  readonly id: string
  readonly name: string
  /** Inner radius, metres. */
  readonly bore: number
  readonly points: readonly (readonly [number, number, number])[]
  readonly kind: 'fuel' | 'coolant' | 'exhaust'
}

/** A declared port: a penetration through a bulkhead, or a hatch. */
export type PortOpening = {
  readonly id: string
  readonly position: readonly [number, number, number]
  readonly radius: number
  readonly kind: string
}

export type EngineRoomOptions = {
  /** The room's own box, in simulation coordinates. */
  readonly room: Aabb
  readonly fittings: readonly Fitting[]
  readonly pipes: readonly PipeRun[]
  readonly ports: readonly PortOpening[]
  /** Everything beyond this plane is cut away. */
  readonly cutZ: number
}

// ------------------------------------------------------------------ palette

const PAINT = {
  /** Painted marine plywood and steel bulkhead. */
  bulkhead: 0x39434f,
  /** The underside of the deck: darker, dirtier. */
  deckhead: 0x2b333c,
  /** The sole: dark, and the darkest thing in the room. */
  sole: 0x161c22,
  /** Engine block: the grey-green of a painted marine diesel. */
  block: 0x445049,
  /** Rocker covers and cam boxes: near black. */
  head: 0x1d2328,
  /** Fabricated steel: engine beds, brackets, headers. */
  steel: 0x5b6068,
  /** Tank: the green of a welded aluminium fuel tank. */
  tank: 0x3c5a48,
  /** Expansion tank: translucent white. */
  header: 0x9aa7ad,
  /** Exhaust insulation: cream lagging. */
  lagging: 0xb9b2a4,
  /** Steel pipe. */
  pipe: 0x6d747c,
  /** Coolant hose: green rubber. */
  hose: 0x2f6b4f,
  /** Crate and stowage. */
  clutter: 0x6a5238,
  /** Rubber isolator. */
  rubber: 0x1a1d20,
  /** Engine-room lighting: warm white. */
  lamp: 0xffe6bd,
  /** The face a solid presents where the model was cut. */
  section: 0xc19a63,
} as const

// ----------------------------------------------------------------- textures

/**
 * Diamond plate, for the sole.
 *
 * The pattern is drawn once into a canvas and tiled, rather than modelled. A
 * modelled tread pattern on a 5.7 m sole is thousands of triangles for a
 * texture that has to be read at a distance and at a grazing angle, and the
 * painted version catches the strip lights the same way the real one does.
 */
export function diamondPlateTexture(repeatX = 6, repeatY = 3): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const c = canvas.getContext('2d')!
  c.fillStyle = '#1b2229'
  c.fillRect(0, 0, size, size)
  c.strokeStyle = '#39434d'
  c.lineWidth = 7
  c.lineCap = 'round'
  // Two rows of opposed lozenges, the pattern of a real chequer plate.
  for (let i = 0; i < 4; i++) {
    const o = i * 32
    c.beginPath()
    c.moveTo(o + 6, 12)
    c.lineTo(o + 20, 2)
    c.moveTo(o + 6, 44)
    c.lineTo(o + 20, 34)
    c.stroke()
    c.beginPath()
    c.moveTo(o + 38, 22)
    c.lineTo(o + 52, 12)
    c.moveTo(o + 38, 54)
    c.lineTo(o + 52, 44)
    c.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(repeatX, repeatY)
  return texture
}

// ------------------------------------------------------------------ helpers

function phong(
  colour: number,
  opts: { shininess?: number; specular?: number; opacity?: number } = {},
): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({
    color: colour,
    shininess: opts.shininess ?? 24,
    specular: opts.specular ?? 0x2a3644,
  })
  if (opts.opacity !== undefined && opts.opacity < 1) {
    material.transparent = true
    material.opacity = opts.opacity
  }
  return material
}

function boxMesh(w: number, h: number, d: number, colour: number, opts = {}): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), phong(colour, opts))
}

/**
 * A thin skin on one face of a declared envelope.
 *
 * The declared obstacles are solid volumes; a bulkhead drawn as its whole
 * volume is a slab that hides the room. A bulkhead is a *surface*, and the
 * surface is what a person in the compartment would see.
 */
function skin(aabb: Aabb, axis: 'x' | 'y' | 'z', side: -1 | 1, thickness: number, colour: number): THREE.Mesh {
  const size: [number, number, number] =
    axis === 'x'
      ? [thickness, aabb.maxY - aabb.minY, aabb.maxZ - aabb.minZ]
      : axis === 'y'
        ? [aabb.maxX - aabb.minX, thickness, aabb.maxZ - aabb.minZ]
        : [aabb.maxX - aabb.minX, aabb.maxY - aabb.minY, thickness]
  const mesh = boxMesh(size[0], size[1], size[2], colour)
  const at: number =
    axis === 'x'
      ? side < 0
        ? aabb.minX + thickness / 2
        : aabb.maxX - thickness / 2
      : axis === 'y'
        ? side < 0
          ? aabb.minY + thickness / 2
          : aabb.maxY - thickness / 2
        : side < 0
          ? aabb.minZ + thickness / 2
          : aabb.maxZ - thickness / 2
  mesh.position.set(
    axis === 'x' ? at : (aabb.minX + aabb.maxX) / 2,
    axis === 'y' ? at : (aabb.minY + aabb.maxY) / 2,
    axis === 'z' ? at : (aabb.minZ + aabb.maxZ) / 2,
  )
  return mesh
}

/** A cylinder running from one point to another. */
function tubeBetween(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  radius: number,
  colour: number,
  opts: { shininess?: number; specular?: number; opacity?: number } = {},
): THREE.Mesh {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, Math.max(0.001, length), 12),
    phong(colour, opts),
  )
  mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
  const up = new THREE.Vector3(0, 1, 0)
  const dir = new THREE.Vector3(dx, dy, dz).normalize()
  mesh.quaternion.setFromUnitVectors(up, dir)
  return mesh
}

function ball(radius: number, colour: number, at: readonly [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), phong(colour))
  mesh.position.set(at[0], at[1], at[2])
  return mesh
}

/** A small engraved plate, fixed to a piece of machinery. */
function namePlate(text: string, colour: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = '600 26px ui-monospace, Menlo, Consolas, monospace'
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 18
  canvas.width = w
  canvas.height = 34
  const c = canvas.getContext('2d')!
  c.font = font
  c.fillStyle = 'rgba(10,13,17,0.72)'
  c.fillRect(0, 0, w, 34)
  c.fillStyle = `#${colour.toString(16).padStart(6, '0')}`
  c.fillRect(0, 0, 4, 34)
  c.fillStyle = '#9fb0bd'
  c.fillText(text, 11, 24)
  const texture = new THREE.CanvasTexture(canvas)
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
  )
  const h = 0.1
  sprite.scale.set(h * (w / 34), h, 1)
  sprite.renderOrder = 11
  return sprite
}

// ------------------------------------------------------------------- the cut

/**
 * A declared envelope, after the cut.
 *
 * `gone` means the whole of it was on the far side of the cut and there is
 * nothing to draw. `cut` means the cut passed through it and it needs a
 * section face.
 */
type Cut = {
  readonly aabb: Aabb
  readonly cut: boolean
  readonly gone: boolean
}

function clip(aabb: Aabb, cutZ: number): Cut {
  if (aabb.minZ >= cutZ) return { aabb, cut: false, gone: true }
  if (aabb.maxZ <= cutZ) return { aabb, cut: false, gone: false }
  return { aabb: { ...aabb, maxZ: cutZ }, cut: true, gone: false }
}

/**
 * The face a cut solid presents to the viewer.
 *
 * Marked in a warmer colour than the solid itself, the way a sectional drawing
 * marks the plane it was sliced on. Without it a cut engine reads as a short
 * engine, and the viewer is looking at a mistake rather than at a section.
 */
function sectionFace(aabb: Aabb, cutZ: number): THREE.Mesh {
  const mesh = boxMesh(aabb.maxX - aabb.minX, aabb.maxY - aabb.minY, 0.012, PAINT.section, {
    shininess: 10,
    specular: 0x201a12,
  })
  mesh.position.set((aabb.minX + aabb.maxX) / 2, (aabb.minY + aabb.maxY) / 2, cutZ - 0.004)
  return mesh
}

// -------------------------------------------------------------- the machines

/**
 * One part's z extent, after the cut.
 *
 * `null` means the part was entirely on the far side of the cut and is not
 * drawn at all. Otherwise the part is *sectioned*: it keeps its own position
 * and proportions and is simply stopped at the cut plane.
 *
 * The distinction matters. A machine whose envelope is shortened and then
 * rebuilt from the shortened envelope comes out squashed, and a squashed
 * engine is a mistake rather than a section.
 */
function span(z0: number, z1: number, cutZ: number): { z0: number; z1: number } | null {
  if (z0 >= cutZ) return null
  return { z0, z1: Math.min(z1, cutZ) }
}

/** A slab whose z extent has already been sectioned. */
function slab(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z: { z0: number; z1: number },
  colour: number,
  opts: { shininess?: number; specular?: number } = {},
): THREE.Mesh {
  const mesh = boxMesh(x1 - x0, y1 - y0, z.z1 - z.z0, colour, opts)
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z.z0 + z.z1) / 2)
  return mesh
}

/** A tube between two points, stopped at the cut plane. */
function clippedTube(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  radius: number,
  colour: number,
  cutZ: number,
  opts: { shininess?: number; specular?: number; opacity?: number } = {},
): THREE.Mesh | null {
  if (a[2] >= cutZ && b[2] >= cutZ) return null
  const end: readonly [number, number, number] =
    a[2] >= cutZ
      ? [b[0] + ((a[0] - b[0]) * (cutZ - b[2])) / (a[2] - b[2]), b[1], cutZ]
      : b[2] >= cutZ
        ? [a[0] + ((b[0] - a[0]) * (cutZ - a[2])) / (b[2] - a[2]), a[1], cutZ]
        : b
  return tubeBetween(a, end, radius, colour, opts)
}

/**
 * One of the two main engines.
 *
 * A marine diesel in a beam of 2.3 m: a fabricated bed on four rubber
 * isolators, a block with two banks of cylinder heads under cam covers, an
 * exhaust manifold with four branches on the outboard side, a turbocharger at
 * the after end, and a sea suction strainer low down where the hull is.
 *
 * Everything sits inside the declared envelope. The engine is 1.6 m long, 1.07 m
 * across and 0.55 m tall in the model, and it is drawn at exactly that size.
 *
 * Where the cut passes through it the engine is sectioned: the parts beyond
 * the plane are not drawn, the parts crossing it are stopped at the plane, and
 * the block is given a section face. A cut engine is a drawing of an engine
 * with a piece of it removed; it is not a shorter engine.
 */
function buildEngine(aabb: Aabb, outboard: -1 | 1, cutZ: number): THREE.Group {
  const g = new THREE.Group()
  const x0 = aabb.minX
  const x1 = aabb.maxX
  const z0 = aabb.minZ
  const z1 = aabb.maxZ
  const y0 = aabb.minY
  const y1 = aabb.maxY
  const len = x1 - x0
  const width = z1 - z0
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const side = Math.abs(cz)

  // -- the bed: two side rails with an open centre, which is how a bed is made
  //    and which leaves the fuel line somewhere to run. The declared centreline
  //    bed is drawn separately; this is the engine's own bearers.
  for (const railZ of [z0 + 0.06, z1 - 0.06]) {
    const z = span(railZ - 0.03, railZ + 0.03, cutZ)
    if (z === null) continue
    g.add(slab(x0, x1, y0, y0 + 0.1, z, PAINT.steel, { shininess: 40 }))
  }
  {
    const z = span(z0 + width * 0.1, z0 + width * 0.9, cutZ)
    if (z !== null) g.add(slab(x0 + 0.08, x0 + 0.16, y0, y0 + 0.09, z, PAINT.steel))
  }

  // -- rubber isolators, and the holding-down bolts through them.
  for (const fx of [x0 + 0.16, x1 - 0.16]) {
    for (const fz of [z0 + 0.14, z1 - 0.14]) {
      if (fz >= cutZ) continue
      const iso = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.06, 0.07, 10),
        phong(PAINT.rubber, { shininess: 6, specular: 0x0a0c0e }),
      )
      iso.position.set(fx, y0 + 0.135, fz)
      g.add(iso)
    }
  }

  // -- the block.
  {
    const z = span(cz - width * 0.41, cz + width * 0.41, cutZ)
    if (z !== null) {
      g.add(slab(x0 + len * 0.04, x1 - len * 0.04, y0 + 0.175, y0 + 0.345, z, PAINT.block, { shininess: 46 }))
    }
  }

  // -- the cylinder heads: two banks, angled, under their cam covers.
  for (const s of [-1, 1] as const) {
    const headZ = cz + s * side * 0.44
    const z = span(headZ - width * 0.15, headZ + width * 0.15, cutZ)
    if (z !== null) {
      const head = slab(x0 + len * 0.07, x1 - len * 0.07, y0 + 0.35, y0 + 0.45, z, PAINT.head, {
        shininess: 60,
      })
      head.rotation.x = s * 0.16
      g.add(head)
    }
    const coverZ = cz + s * side * 0.46
    const c = span(coverZ - width * 0.13, coverZ + width * 0.13, cutZ)
    if (c !== null) {
      g.add(slab(x0 + len * 0.1, x1 - len * 0.1, y0 + 0.445, y0 + 0.495, c, 0x171b1f, { shininess: 70 }))
    }
    // Four exhaust branches leaving the bank for the manifold.
    for (let i = 0; i < 4; i++) {
      const bx = x0 + 0.22 + (i * (len - 0.44)) / 3
      const branch = clippedTube(
        [bx, y0 + 0.42, cz + s * side * 0.62],
        [bx, y0 + 0.42, cz + s * side * 0.86],
        0.028,
        0x6a6258,
        cutZ,
      )
      if (branch !== null) g.add(branch)
    }
  }

  // -- the exhaust manifold, a fat lagged pipe along the outboard flank.
  const manifoldZ = cz + outboard * (side * 0.92)
  if (manifoldZ < cutZ) {
    g.add(
      tubeBetween(
        [x0 + 0.2, y0 + 0.42, manifoldZ],
        [x1 - 0.14, y0 + 0.42, manifoldZ],
        0.075,
        PAINT.lagging,
        { shininess: 8, specular: 0x1a1a18 },
      ),
    )

    // -- the turbocharger: a snail at the after end of the manifold.
    const turbo = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.045, 8, 16), phong(0x7d6a52))
    turbo.position.set(x0 + 0.16, y0 + 0.42, manifoldZ)
    turbo.rotation.y = Math.PI / 2
    g.add(turbo)
  }

  // -- the air cooler on top of the block.
  {
    const z = span(cz - width * 0.25, cz + width * 0.25, cutZ)
    if (z !== null) {
      g.add(slab(cx + len * 0.12 - len * 0.22, cx + len * 0.12 + len * 0.22, y1 - 0.09, y1, z, 0x8d949a, {
        shininess: 60,
      }))
    }
  }

  // -- the sea suction strainer: a dome low on the outboard side, where it
  //    actually is on a boat — on the hull, below the waterline, ahead of the
  //    engine.
  {
    const strainerZ = cz + outboard * (side - 0.1)
    if (strainerZ < cutZ) {
      const strainer = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        phong(0x6b7076, { shininess: 30 }),
      )
      strainer.position.set(x1 - 0.12, y0 + 0.03, strainerZ)
      g.add(strainer)
    }
  }

  return g
}

/** The gearbox: a housing, a coupling, and the shaft it drives. */
function buildGearbox(aabb: Aabb, cutZ: number): THREE.Group {
  const g = new THREE.Group()
  const cx = (aabb.minX + aabb.maxX) / 2
  const cy = (aabb.minY + aabb.maxY) / 2
  const cz = (aabb.minZ + aabb.maxZ) / 2
  const len = aabb.maxX - aabb.minX
  const z = span(aabb.minZ, aabb.maxZ, cutZ)
  if (z === null) return g

  const housing = boxMesh(len * 0.66, (aabb.maxY - aabb.minY) * 0.86, (z.z1 - z.z0) * 0.7, PAINT.block, {
    shininess: 46,
  })
  housing.position.set(cx, cy + 0.02, (z.z0 + z.z1) / 2)
  g.add(housing)

  // The bell housing, tapering aft to the coupling.
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, len * 0.3, 14), phong(PAINT.block))
  bell.rotation.z = Math.PI / 2
  bell.position.set(aabb.minX + len * 0.2, cy, cz)
  g.add(bell)

  // The coupling and the propshaft going forward, through the brackets.
  g.add(
    tubeBetween(
      [aabb.maxX - 0.02, cy - 0.02, cz],
      [aabb.maxX + 0.62, cy - 0.02, cz],
      0.035,
      0x8f959b,
      { shininess: 80 },
    ),
  )
  const coupling = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.1, 12), phong(0x9aa1a7))
  coupling.rotation.z = Math.PI / 2
  coupling.position.set(aabb.maxX + 0.05, cy - 0.02, cz)
  g.add(coupling)
  return g
}

/** A welded tank: a painted box with a band, a sight glass and a filler. */
function buildTank(aabb: Aabb, translucent: boolean, cutZ: number): THREE.Group {
  const g = new THREE.Group()
  const cx = (aabb.minX + aabb.maxX) / 2
  const cy = (aabb.minY + aabb.maxY) / 2
  const w = aabb.maxX - aabb.minX
  const h = aabb.maxY - aabb.minY
  const z = span(aabb.minZ, aabb.maxZ, cutZ)
  if (z === null) return g
  const d = z.z1 - z.z0

  const body = boxMesh(w, h * 0.86, d, translucent ? PAINT.header : PAINT.tank, {
    shininess: translucent ? 70 : 18,
    specular: 0x556677,
    opacity: translucent ? 0.7 : 1,
  })
  body.position.set(cx, cy - h * 0.07, (z.z0 + z.z1) / 2)
  g.add(body)

  // The saddle it sits in.
  const saddle = boxMesh(w * 1.04, h * 0.16, d * 1.04, PAINT.steel)
  saddle.position.set(cx, aabb.minY + h * 0.08, (z.z0 + z.z1) / 2)
  g.add(saddle)

  // A welded band around the middle.
  const band = boxMesh(w + 0.012, 0.035, d + 0.012, 0x9aa2a8, { shininess: 60 })
  band.position.set(cx, cy + h * 0.16, (z.z0 + z.z1) / 2)
  g.add(band)

  // The filler neck and its cap.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.05, 10), phong(0x8d949a))
  neck.position.set(cx + w * 0.28, aabb.maxY + 0.01, (z.z0 + z.z1) / 2)
  g.add(neck)

  // The sight glass: a slim bright strip on the outboard face.
  const sight = boxMesh(0.03, h * 0.5, 0.012, 0xd8e6b0, { shininess: 90, specular: 0xaabbcc })
  sight.position.set(cx - w * 0.3, cy, z.z1 + 0.006)
  g.add(sight)
  return g
}

/**
 * The engine bed's centreline girder.
 *
 * The declared bed is a narrow strip on the centreline, between the two
 * engines, and the fuel line runs along it. So it is drawn as what it is: a
 * fabricated channel section — two webs with a tie across the top — and the
 * pipe lies in the channel between them, with the crawler inside the pipe.
 *
 * Everything is inside the declared envelope. The channel is open because the
 * conduit is a separate manifold from the structure: a crawler goes in the
 * pipe and nothing else does.
 */
function buildBed(aabb: Aabb, cutZ: number): THREE.Group {
  const g = new THREE.Group()
  const x0 = aabb.minX
  const x1 = aabb.maxX
  const y0 = aabb.minY
  const y1 = aabb.maxY
  const z0 = aabb.minZ
  const z1 = aabb.maxZ
  const web = 0.018
  // Two webs, one each side of the channel.
  for (const [za, zb] of [
    [z0, z0 + web],
    [z1 - web, z1],
  ] as const) {
    const z = span(za, zb, cutZ)
    if (z === null) continue
    g.add(slab(x0, x1, y0, y1, z, PAINT.steel, { shininess: 40 }))
  }
  // Ties across the top, clear of the pipe below them.
  for (let x = x0 + 0.22; x < x1 - 0.1; x += 0.55) {
    const z = span(z0, z1, cutZ)
    if (z === null) break
    g.add(slab(x, x + 0.05, y1 - 0.04, y1, z, PAINT.steel))
  }
  return g
}

/** A crate of stowage: a box with a lid and two ratchet straps. */
function buildCrate(aabb: Aabb, cutZ: number): THREE.Group {
  const g = new THREE.Group()
  const cx = (aabb.minX + aabb.maxX) / 2
  const cy = (aabb.minY + aabb.maxY) / 2
  const w = aabb.maxX - aabb.minX
  const h = aabb.maxY - aabb.minY
  const z = span(aabb.minZ, aabb.maxZ, cutZ)
  if (z === null) return g
  const cz = (z.z0 + z.z1) / 2
  const d = z.z1 - z.z0
  g.add(boxMesh(w, h * 0.88, d, PAINT.clutter, { shininess: 8, specular: 0x181410 }))
  const lid = boxMesh(w * 1.04, h * 0.12, d * 1.04, 0x53412c, { shininess: 8 })
  lid.position.set(cx, aabb.maxY - h * 0.06, cz)
  g.add(lid)
  for (const fx of [-0.22, 0.22]) {
    const strap = boxMesh(0.02, h * 0.94, d * 1.06, 0x2a2e33)
    strap.position.set(cx + w * fx, cy, cz)
    g.add(strap)
  }
  return g
}

/** A P-bracket carrying the propshaft, on a rubber bearing. */
function buildShaftBracket(aabb: Aabb, cutZ: number): THREE.Group {
  const g = new THREE.Group()
  const cx = (aabb.minX + aabb.maxX) / 2
  const h = aabb.maxY - aabb.minY
  const z = span(aabb.minZ, aabb.maxZ, cutZ)
  if (z === null) return g
  const cz = (z.z0 + z.z1) / 2
  const d = z.z1 - z.z0
  // The post.
  const post = boxMesh(0.08, h, 0.1, PAINT.steel)
  post.position.set(cx, h / 2, cz)
  g.add(post)
  // The bearing: a V of two pads with a rubber block between them.
  const pad = boxMesh(0.1, 0.12, d * 0.3, PAINT.steel)
  pad.position.set(cx, h - 0.06, cz - d * 0.22)
  g.add(pad)
  const pad2 = pad.clone()
  pad2.position.z = cz + d * 0.22
  g.add(pad2)
  const rubber = boxMesh(0.11, 0.05, d * 0.2, PAINT.rubber)
  rubber.position.set(cx, h - 0.04, cz)
  g.add(rubber)
  return g
}

// --------------------------------------------------------------- the piping

const PIPE_COLOUR: Record<PipeRun['kind'], number> = {
  fuel: PAINT.pipe,
  coolant: PAINT.hose,
  exhaust: PAINT.lagging,
}

/**
 * A declared conduit, drawn as a pipe run.
 *
 * The fuel line is drawn as a **cutaway**: a translucent shell with an opaque
 * bore line, so that the inchworm inside it can be seen. A crawler in an
 * opaque pipe is a crawler the demo cannot show.
 */
function buildPipe(run: PipeRun, cutZ: number): THREE.Group {
  const g = new THREE.Group()
  const colour = PIPE_COLOUR[run.kind]
  const outer = run.bore * 1.2
  const cutaway = run.kind === 'fuel'

  // The run, clipped to the cut.
  const points = run.points.map((p) => [p[0], p[1], Math.min(p[2], cutZ)] as const)
  const kept: (readonly [number, number, number])[] = []
  for (const p of points) {
    if (p[2] < cutZ - 1e-6) kept.push(p)
    else break
  }
  if (kept.length < 2) return g

  for (let i = 0; i < kept.length - 1; i++) {
    const a = kept[i]!
    const b = kept[i + 1]!
    g.add(
      tubeBetween(a, b, outer, colour, {
        shininess: run.kind === 'exhaust' ? 6 : 50,
        specular: run.kind === 'exhaust' ? 0x14140f : 0x445566,
        opacity: cutaway ? 0.34 : 1,
      }),
    )
  }
  // Elbows: a ball at every interior vertex.
  for (let i = 1; i < kept.length - 1; i++) {
    const p = kept[i]!
    g.add(ball(outer, colour, p))
  }
  // Flanged ends.
  for (const end of [kept[0]!, kept[kept.length - 1]!]) {
    const next = end === kept[0] ? kept[1]! : kept[kept.length - 2]!
    const dir = new THREE.Vector3(end[0] - next[0], end[1] - next[1], end[2] - next[2]).normalize()
    const flange = new THREE.Mesh(
      new THREE.CylinderGeometry(outer * 1.7, outer * 1.7, 0.035, 12),
      phong(0x8f959b, { shininess: 70 }),
    )
    flange.position.set(end[0], end[1], end[2])
    flange.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    g.add(flange)
  }
  // The bore, drawn as a bright core line so a cutaway reads as a cutaway.
  if (cutaway) {
    for (let i = 0; i < kept.length - 1; i++) {
      g.add(tubeBetween(kept[i]!, kept[i + 1]!, run.bore * 0.35, 0x1a2026))
    }
  }
  return g
}

// ---------------------------------------------------------------- the room

/**
 * The engine room.
 *
 * A real one, as far as the declared geometry allows: a plated sole with a
 * drain, painted bulkheads on frames, a deckhead of transverse beams, two
 * diesels on isolators, a gearbox driving the shaft through two P-brackets, a
 * fuel tank forward, an expansion tank aft, a lagged exhaust header, the three
 * declared pipe runs, and two strip lights.
 */
export function addEngineRoom(group: THREE.Group, options: EngineRoomOptions): void {
  const { room, fittings, pipes, ports, cutZ } = options
  const byId = new Map(fittings.map((f) => [f.id, f]))

  // -- the sole ---------------------------------------------------------------
  const soleBox = clip({ ...room, minY: room.minY, maxY: room.minY + 0.01 }, cutZ)
  if (!soleBox.gone) {
    const soleTexture = diamondPlateTexture()
    const sole = new THREE.Mesh(
      new THREE.PlaneGeometry(soleBox.aabb.maxX - soleBox.aabb.minX, soleBox.aabb.maxZ - soleBox.aabb.minZ).rotateX(
        -Math.PI / 2,
      ),
      new THREE.MeshPhongMaterial({
        color: 0xffffff,
        map: soleTexture,
        shininess: 30,
        specular: 0x2c3a48,
      }),
    )
    sole.position.set(
      (soleBox.aabb.minX + soleBox.aabb.maxX) / 2,
      room.minY + 0.004,
      (soleBox.aabb.minZ + soleBox.aabb.maxZ) / 2,
    )
    sole.name = 'sole'
    group.add(sole)
  }

  // The bilge drain: the stowage in the content file is named for sitting over
  // it, so the grating goes where the name says it is.
  const overDrain = byId.get('stowage-over-drain')
  if (overDrain !== undefined && overDrain.aabb.minZ < cutZ) {
    const dx = (overDrain.aabb.minX + overDrain.aabb.maxX) / 2
    const dz = (overDrain.aabb.minZ + overDrain.aabb.maxZ) / 2
    const sump = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.3), phong(0x0d1116, { shininess: 4 }))
    sump.position.set(dx, room.minY - 0.02, dz)
    group.add(sump)
    for (let i = 0; i < 5; i++) {
      const bar = boxMesh(0.28, 0.012, 0.02, 0x7d858c, { shininess: 60 })
      bar.position.set(dx, room.minY + 0.004, dz - 0.12 + i * 0.06)
      group.add(bar)
    }
  }

  // -- the bulkheads, on frames ----------------------------------------------
  for (const id of ['hull-aft', 'hull-fwd', 'hull-port', 'hull-stbd']) {
    const f = byId.get(id)
    if (f === undefined) continue
    const c = clip(f.aabb, cutZ)
    if (c.gone) continue
    const wall =
      id === 'hull-aft'
        ? skin(c.aabb, 'x', -1, 0.05, PAINT.bulkhead)
        : id === 'hull-fwd'
          ? skin(c.aabb, 'x', 1, 0.05, PAINT.bulkhead)
          : id === 'hull-port'
            ? skin(c.aabb, 'z', -1, 0.05, PAINT.bulkhead)
            : skin(c.aabb, 'z', 1, 0.05, PAINT.bulkhead)
    wall.name = `wall:${id}`
    group.add(wall)
  }

  // Vertical stiffeners on the side bulkheads. They stand against the paint,
  // from the sole to the deckhead, and they are what makes a bulkhead read as
  // a bulkhead rather than as a grey rectangle.
  for (const [id, side] of [
    ['hull-port', -1],
    ['hull-stbd', 1],
  ] as const) {
    const f = byId.get(id)
    if (f === undefined) continue
    const c = clip(f.aabb, cutZ)
    if (c.gone) continue
    const z = side < 0 ? c.aabb.maxZ : c.aabb.minZ
    for (let x = c.aabb.minX + 0.35; x < c.aabb.maxX; x += 0.62) {
      const web = boxMesh(0.06, room.maxY - room.minY, 0.05, 0x2f3944)
      web.position.set(x, (room.minY + room.maxY) / 2, z + side * 0.028)
      group.add(web)
    }
  }

  // -- the deckhead: transverse beams and a services slot --------------------
  for (const id of ['engine-deckhead-a', 'engine-deckhead-b']) {
    const f = byId.get(id)
    if (f === undefined) continue
    const c = clip(f.aabb, cutZ)
    if (c.gone) continue
    const plate = skin(c.aabb, 'y', -1, 0.05, PAINT.deckhead)
    plate.name = `deckhead:${id}`
    group.add(plate)
  }
  // Transverse deck beams hanging below the plating.
  const deckSpan = Math.min(room.maxZ, cutZ)
  for (let x = room.minX + 0.3; x < room.maxX; x += 0.58) {
    const beam = boxMesh(0.05, 0.13, deckSpan - room.minZ, 0x323c46)
    beam.position.set(x, room.maxY - 0.065, (room.minZ + deckSpan) / 2)
    beam.name = 'beam'
    group.add(beam)
    // A flange along the bottom of the beam.
    const flange = boxMesh(0.1, 0.018, deckSpan - room.minZ, 0x3c4750)
    flange.position.set(x, room.maxY - 0.128, (room.minZ + deckSpan) / 2)
    group.add(flange)
  }

  // The engine bay access hatch: a round hatch in the deckhead, forward. It is
  // the way a person gets into the compartment and the way nothing in this
  // swarm gets in.
  const accessHatch = ports.find((p) => p.id === 'hatch-engine-bay')
  if (accessHatch !== undefined && accessHatch.position[2] < cutZ) {
    const [hx, hy, hz] = accessHatch.position
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(accessHatch.radius * 1.15, 0.025, 8, 24).rotateX(Math.PI / 2),
      phong(0x8d949a, { shininess: 60 }),
    )
    rim.position.set(hx, hy - 0.08, hz)
    group.add(rim)
    // The lid, lifted and dogged back against the deckhead.
    const lid = new THREE.Mesh(
      new THREE.CylinderGeometry(accessHatch.radius, accessHatch.radius, 0.03, 20),
      phong(0x7f878e, { shininess: 50 }),
    )
    lid.position.set(hx + accessHatch.radius * 1.4, hy + 0.16, hz)
    lid.rotation.z = 1.15
    group.add(lid)
  }

  // -- the machinery ----------------------------------------------------------
  const named: [string, string][] = [
    ['engine-port', 'PORT ENGINE'],
    ['engine-stbd', 'STBD ENGINE'],
    ['fuel-tank', 'FUEL TANK'],
    ['coolant-tank', 'COOLANT'],
    ['gearbox', 'GEARBOX'],
    ['exhaust-header', 'EXHAUST'],
  ]

  for (const f of fittings) {
    const c = clip(f.aabb, cutZ)
    if (c.gone) continue
    // The machine is built from its **declared** envelope, not from the
    // shortened one. The cut is applied part by part inside the builders, so
    // a machine the plane passed through comes out sectioned rather than
    // squashed. This is the whole difference between a section and a mistake.
    const a = f.aabb
    // Everything is named after the declaration it came from, so a raycast can
    // say which piece of the model is in the picture.
    const put = (thing: THREE.Object3D): void => {
      thing.name = `fit:${f.id}`
      group.add(thing)
    }
    switch (f.id) {
      case 'engine-port':
        put(buildEngine(a, -1, cutZ))
        break
      case 'engine-stbd':
        put(buildEngine(a, 1, cutZ))
        break
      case 'engine-bed':
        put(buildBed(a, cutZ))
        break
      case 'gearbox':
        put(buildGearbox(a, cutZ))
        break
      case 'fuel-tank':
        put(buildTank(a, false, cutZ))
        break
      case 'coolant-tank':
        put(buildTank(a, true, cutZ))
        break
      case 'stowage-loose':
      case 'stowage-over-drain':
        put(buildCrate(a, cutZ))
        break
      case 'shaft-bracket-port':
      case 'shaft-bracket-stbd':
        put(buildShaftBracket(a, cutZ))
        break
      case 'exhaust-header': {
        // The header: a lagged exhaust pipe with a water-jacketed elbow.
        const cx = (a.minX + a.maxX) / 2
        const cy = (a.minY + a.maxY) / 2
        const cz = (a.minZ + a.maxZ) / 2
        put(
          tubeBetween([a.minX - 0.08, cy, cz], [a.maxX + 0.06, cy, cz], 0.11, PAINT.lagging, {
            shininess: 6,
            specular: 0x14140f,
          }),
        )
        put(ball(0.11, PAINT.lagging, [a.maxX + 0.06, cy, cz]))
        // The elbow down to the exhaust run.
        put(
          tubeBetween([a.maxX + 0.06, cy, cz], [a.maxX + 0.2, cy - 0.08, cz], 0.11, PAINT.lagging, {
            shininess: 6,
          }),
        )
        // A band, and the flexible bellows at the forward end.
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(0.115, 0.012, 6, 16).rotateY(Math.PI / 2),
          phong(0x8d949a, { shininess: 70 }),
        )
        band.position.set(cx, cy, cz)
        put(band)
        break
      }
      default:
        break
    }
    // The section face, where the cut went through a solid.
    if (c.cut) {
      const face = sectionFace(a, cutZ)
      face.name = `section:${f.id}`
      group.add(face)
    }
  }

  // -- the pipe runs ----------------------------------------------------------
  for (const run of pipes) {
    const pipe = buildPipe(run, cutZ)
    pipe.name = `pipe:${run.id}`
    group.add(pipe)
  }

  // -- the penetrations through the bulkheads ---------------------------------
  for (const port of ports) {
    if (port.kind === 'hatch') continue
    if (port.position[2] > cutZ) continue
    if (port.kind === 'vent') {
      // A ventilation louvre: a round duct with a grille.
      const collar = new THREE.Mesh(
        new THREE.TorusGeometry(port.radius * 1.1, 0.03, 8, 18).rotateY(Math.PI / 2),
        phong(0x8d949a, { shininess: 60 }),
      )
      collar.position.set(port.position[0], port.position[1], port.position[2])
      group.add(collar)
      for (let i = 0; i < 4; i++) {
        const louvre = boxMesh(0.02, port.radius * 1.6, 0.05, 0x5b636b)
        louvre.position.set(
          port.position[0],
          port.position[1] - port.radius * 0.6 + i * port.radius * 0.4,
          port.position[2],
        )
        louvre.rotation.x = 0.4
        group.add(louvre)
      }
      continue
    }
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(port.radius * 1.6, port.radius * 1.6, 0.03, 12).rotateZ(Math.PI / 2),
      phong(0x8d949a, { shininess: 70 }),
    )
    collar.position.set(port.position[0], port.position[1], port.position[2])
    group.add(collar)
  }

  // -- the lighting -----------------------------------------------------------
  // Two strip lights along the deckhead. A compartment with no light in it is
  // a diagram of a compartment.
  for (const z of [room.minZ + 0.55, Math.min(room.maxZ, cutZ) - 0.45]) {
    const fitting = boxMesh(room.maxX - room.minX - 1.4, 0.05, 0.09, 0x2a3038)
    fitting.position.set((room.minX + room.maxX) / 2, room.maxY - 0.16, z)
    group.add(fitting)
    const tube = new THREE.Mesh(
      new THREE.BoxGeometry(room.maxX - room.minX - 1.5, 0.03, 0.06),
      new THREE.MeshBasicMaterial({ color: PAINT.lamp }),
    )
    tube.position.set((room.minX + room.maxX) / 2, room.maxY - 0.19, z)
    group.add(tube)
    const lamp = new THREE.PointLight(0xffd9a0, 3.4, 7.5, 2)
    lamp.position.set((room.minX + room.maxX) / 2, room.maxY - 0.24, z)
    group.add(lamp)
  }

  // -- the labels -------------------------------------------------------------
  for (const [id, text] of named) {
    const f = byId.get(id)
    if (f === undefined) continue
    const c = clip(f.aabb, cutZ)
    if (c.gone) continue
    const plate = namePlate(text, 0x6d8fa0)
    plate.position.set(
      (c.aabb.minX + c.aabb.maxX) / 2,
      c.aabb.maxY + 0.16,
      (c.aabb.minZ + c.aabb.maxZ) / 2,
    )
    group.add(plate)
  }
}

/**
 * The void walls, drawn as surfaces rather than volumes.
 *
 * The stringer void is the largest space on the boat and the one the swarm
 * cannot enter. Drawn as the solid boxes the model declares, it would be a
 * slab of grey with the fault in it buried inside. Drawn as the inner faces of
 * those boxes, it is a space: you can see into it, you can see that nobody is
 * in it, and the fault inside it is visible.
 */
export function addVoidWalls(
  group: THREE.Group,
  voids: readonly { readonly id: string; readonly aabb: Aabb }[],
  fittings: readonly Fitting[],
  cutZ: number,
): void {
  const byId = new Map(fittings.map((f) => [f.id, f]))
  for (const v of voids) {
    if (v.id !== 'stringer-fwd') continue
    for (const [id, axis, side] of [
      ['stringer-inboard', 'z', 1],
      ['stringer-aft-bulkhead', 'x', 1],
      ['stringer-fwd-bulkhead', 'x', -1],
    ] as const) {
      const f = byId.get(id)
      if (f === undefined) continue
      const c = clip(f.aabb, cutZ)
      if (c.gone) continue
      group.add(skin(c.aabb, axis, side, 0.04, 0x232b34))
    }
    // The floor of the void: the inside of the forward hull bottom.
    const bottom = byId.get('hull-bottom-fwd')
    if (bottom !== undefined) {
      const c = clip(bottom.aabb, cutZ)
      if (!c.gone) group.add(skin(c.aabb, 'y', 1, 0.04, 0x1e252d))
    }
  }
}
