/**
 * The yacht scene.
 *
 * ## What this draws
 *
 * The boat, cut open, with three machines working inside it.
 *
 * The subject is not the boat — it is the swarm. The hull is a ghost cage
 * because a solid hull hides exactly what the demo is about, and the light is
 * the subject: the coverage blooms behind the robots as they work, the engine
 * room fills up, and the forward stringer void stays black.
 *
 * ## Why the robots are hard to see and what is done about it
 *
 * A ground robot is 340 mm across on a 17 m boat. At any distance that frames
 * the boat, it is a speck. The three answers, and they are used together:
 *
 * 1. **The camera gets close.** The director has shots that lock onto each
 *    robot from four metres, which is the only way a 340 mm machine reads.
 * 2. **A lock-on reticle that scales with distance**, so the marker covers the
 *    same fraction of the screen whether the robot is four metres away or
 *    thirty. A marker of fixed world size is either invisible or enormous.
 * 3. **A trail**, because where a machine has been is more legible than where
 *    it is. The crawler's trail is the fuel line: the pipe is drawn by the
 *    thing that went down it.
 *
 * The inchworm is 80 mm inside a 60 mm bore, and there is no camera position
 * from which that is a visible object. Its shot is therefore shot *along* the
 * bore, with the bore lit from the crawler, and the trail is the pipe.
 */

import * as THREE from 'three'
import type { SimFrame } from '../sim/report/frame.ts'
import { buildHullGeometry } from './hull.ts'
import { hullBottomYSim } from '../sim/world/yacht-form.ts'
import type { HullForm } from '../sim/world/yacht-form.ts'

const COLOURS = {
  bg: 0x07090c,
  hull: 0x1b2430,
  hullEdge: 0x3d4b5c,
  plating: 0x39424f,
  profile: 0x8fa3b8,
  coverage: 0x4fd1c5,
  coverageHot: 0xa8fff0,
  void: 0x63b3ed,
  voidUnreachable: 0xff5f56,
  agentGround: 0x4fd1c5,
  agentCrawler: 0xffb454,
  agentHover: 0x68d391,
  finding: 0xf6e05e,
  truth: 0xc792ea,
  human: 0xd8e2ec,
}

export type SpaceDef = {
  readonly id: string
  readonly name: string
  readonly aabb: {
    readonly minX: number
    readonly minY: number
    readonly minZ: number
    readonly maxX: number
    readonly maxY: number
    readonly maxZ: number
  }
  readonly kind: 'room' | 'void'
}

export type YachtSceneOptions = {
  readonly form: HullForm
  readonly spaces: readonly SpaceDef[]
  readonly cutZ: number
}

export type YachtScene = {
  readonly group: THREE.Group
  /** The camera, for the distance-scaled reticles. */
  setCamera(camera: THREE.Camera): void
  setFrame(frame: SimFrame, elapsed: number): void
  /** Extend the trails to the agent positions in this frame. */
  setTrailPoints(frame: SimFrame): void
  dispose: () => void
}

// ---------------------------------------------------------------- textures

function makeLabel(text: string, colour: number, scale = 1): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = '500 34px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 20
  canvas.width = w
  canvas.height = 48
  const c = canvas.getContext('2d')!
  c.font = font
  c.fillStyle = 'rgba(7,9,12,0.78)'
  c.fillRect(0, 0, w, 48)
  c.strokeStyle = `#${colour.toString(16).padStart(6, '0')}`
  c.globalAlpha = 0.5
  c.strokeRect(0.5, 0.5, w - 1, 47)
  c.globalAlpha = 1
  c.fillStyle = `#${colour.toString(16).padStart(6, '0')}`
  c.fillText(text, 10, 32)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    }),
  )
  // With size attenuation off, the scale is a fraction of the viewport height,
  // so the label is the same size on screen wherever the camera is.
  const h = 0.028 * scale
  sprite.scale.set(h * (w / 48), h, 1)
  sprite.renderOrder = 14
  return sprite
}

/** A soft radial dot, for the light fields. */
function makeDotTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const c = canvas.getContext('2d')!
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.3, 'rgba(255,255,255,0.42)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.08)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g
  c.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(canvas)
  t.needsUpdate = true
  return t
}

function makeGlow(colour: number, size: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const c = canvas.getContext('2d')!
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64)
  const hex = `#${colour.toString(16).padStart(6, '0')}`
  g.addColorStop(0, `${hex}ff`)
  g.addColorStop(0.16, `${hex}88`)
  g.addColorStop(0.45, `${hex}18`)
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
  sprite.renderOrder = 10
  return sprite
}

// ---------------------------------------------------------------- the trail

/**
 * A ribbon of where a machine has been.
 *
 * A `THREE.Line` would be one pixel wide, and a one-pixel line on a 17 m boat
 * is invisible. So the trail is a triangle strip: two vertices per point,
 * offset along the normal, which is a few lines of bookkeeping and the
 * difference between a line and a road.
 */
class Trail {
  private readonly positions: Float32Array
  private readonly colours: Float32Array
  private readonly geometry = new THREE.BufferGeometry()
  private readonly mesh: THREE.Mesh
  private count = 0
  private last = { x: Number.NaN, y: 0, z: 0 }

  constructor(
    private readonly colour: number,
    private readonly width: number,
    private readonly maxPoints: number,
  ) {
    this.positions = new Float32Array(maxPoints * 2 * 3)
    this.colours = new Float32Array(maxPoints * 2 * 3)
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colours, 3))
    const indices: number[] = []
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    this.geometry.setIndex(indices)
    this.geometry.setDrawRange(0, 0)
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 8
  }

  get object(): THREE.Mesh {
    return this.mesh
  }

  /** Add a point, if it is far enough from the last one to be worth a segment. */
  push(x: number, y: number, z: number, minStep = 0.12): void {
    if (this.count >= this.maxPoints) return
    if (!Number.isNaN(this.last.x)) {
      const d = Math.hypot(x - this.last.x, z - this.last.z)
      if (d < minStep) return
    }
    // The direction of the new segment, measured from the PREVIOUS point, and
    // the normal to it in the ground plane. The normal is what makes the ribbon
    // a ribbon.
    //
    // The previous point has to be read before it is overwritten. It was not,
    // and so every segment was computed as (x - x) and fell through to the
    // fallback: every trail ran along the same axis regardless of where the
    // machine had actually been. A trail that does not follow the machine is
    // worse than no trail, because it looks like one.
    let dx = x - this.last.x
    let dz = z - this.last.z
    const len = Math.hypot(dx, dz)
    if (!Number.isFinite(len) || len < 1e-6) {
      dx = 1
      dz = 0
    } else {
      dx /= len
      dz /= len
    }
    this.last = { x, y, z }

    const nx = -dz * this.width
    const nz = dx * this.width

    const i = this.count * 6
    this.positions[i] = x + nx
    this.positions[i + 1] = y
    this.positions[i + 2] = z + nz
    this.positions[i + 3] = x - nx
    this.positions[i + 4] = y
    this.positions[i + 5] = z - nz

    // The head of the trail is bright and the tail is dim, so the direction of
    // travel reads without an arrow.
    const c = new THREE.Color(this.colour)
    const head = this.count / Math.max(1, this.maxPoints)
    const k = 0.25 + head * 1.1
    this.colours[i] = c.r * k
    this.colours[i + 1] = c.g * k
    this.colours[i + 2] = c.b * k
    this.colours[i + 3] = c.r * k
    this.colours[i + 4] = c.g * k
    this.colours[i + 5] = c.b * k

    this.count++
    this.geometry.setDrawRange(0, Math.max(0, (this.count - 1) * 6))
    this.geometry.getAttribute('position').needsUpdate = true
    this.geometry.getAttribute('color').needsUpdate = true
  }
}

/** A ring that expands and fades: a ping, emitted on a cadence. */
class Ping {
  readonly mesh: THREE.Mesh
  private age = 0
  private readonly life: number

  constructor(colour: number, life: number) {
    this.life = life
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    )
    this.mesh.renderOrder = 9
  }

  fire(x: number, y: number, z: number, radius: number): void {
    this.age = 0
    this.mesh.position.set(x, y, z)
    this.mesh.scale.setScalar(radius)
    this.mesh.visible = true
  }

  update(dt: number): void {
    if (!this.mesh.visible) return
    this.age += dt
    const t = this.age / this.life
    if (t >= 1) {
      this.mesh.visible = false
      return
    }
    const s = this.mesh.scale.x
    this.mesh.scale.setScalar(s * (1 + dt * 2.4))
    const material = this.mesh.material as THREE.MeshBasicMaterial
    material.opacity = 0.5 * (1 - t) * (1 - t)
  }
}

// ---------------------------------------------------------------- the human

/**
 * A person kneeling on the deck, reaching down through a 200 mm hatch.
 *
 * This is the picture the whole project is for, and it is a picture of a
 * *reach*, not of an entry. A 200 mm clear opening is a hand-hole: an arm and
 * a torch go through it, a body does not. The earlier version of this scene put
 * a person standing inside the void, which was impossible and was the visual
 * statement of a claim that was also impossible.
 */
function makeReachingPerson(colour: number): THREE.Group {
  const g = new THREE.Group()
  const material = new THREE.MeshBasicMaterial({
    color: colour,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  })

  const limb = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    radius: number,
  ): THREE.Mesh => {
    const from = new THREE.Vector3(...a)
    const to = new THREE.Vector3(...b)
    const mid = from.clone().add(to).multiplyScalar(0.5)
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, from.distanceTo(to), 3, 8),
      material,
    )
    mesh.position.copy(mid)
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      to.clone().sub(from).normalize(),
    )
    return mesh
  }

  // Kneeling, leaning over the hole. The proportions are a kneeling adult's:
  // shin 0.42, thigh 0.43, hip to shoulder 0.53, head 0.23 across. The first
  // version had a 0.42 torso on a 0.45 shin, which read as a child.
  g.add(limb([0.66, 0.055, 0.1], [0.24, 0.055, 0.1], 0.08)) // shin
  g.add(limb([0.66, 0.055, -0.1], [0.24, 0.055, -0.1], 0.08)) // shin
  g.add(limb([0.66, 0.055, 0.1], [0.64, 0.48, 0.1], 0.085)) // thigh
  g.add(limb([0.66, 0.055, -0.1], [0.64, 0.48, -0.1], 0.085)) // thigh
  g.add(limb([0.64, 0.48, 0], [0.14, 0.66, 0], 0.15)) // torso, leaning forward
  g.add(limb([0.14, 0.66, 0], [0.07, 0.75, 0], 0.055)) // neck
  g.add(limb([0.18, 0.64, 0.13], [0.44, 0.05, 0.18], 0.06)) // arm, braced on the deck
  // The other arm goes down through the hole. The hand is below the deck line,
  // which is the whole point of the figure.
  g.add(limb([0.18, 0.64, -0.1], [0.08, 0.28, -0.08], 0.06))
  g.add(limb([0.08, 0.28, -0.08], [0.0, -0.06, -0.05], 0.055))

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 12), material)
  head.position.set(0.02, 0.85, 0)
  head.scale.set(1, 1.1, 0.92)
  g.add(head)

  return g
}

function makeHuman(heightM: number, colour: number): THREE.Group {
  const g = new THREE.Group()
  const material = new THREE.MeshBasicMaterial({
    color: colour,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
  })
  const s = heightM / 1.8

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11 * s, 12, 10), material)
  head.position.y = 1.69 * s
  g.add(head)

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16 * s, 0.5 * s, 4, 10), material)
  torso.position.y = 1.24 * s
  g.add(torso)

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.07 * s, 0.68 * s, 3, 8), material)
    leg.position.set(side * 0.1 * s, 0.45 * s, 0)
    g.add(leg)
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05 * s, 0.56 * s, 3, 8), material)
    arm.position.set(side * 0.24 * s, 1.2 * s, 0)
    g.add(arm)
  }
  return g
}

// ------------------------------------------------------------ space geometry

/**
 * The geometry of a named space.
 *
 * For a **void** the floor follows the hull, because the void's floor *is* the
 * hull: the stringer void is the space between the stringers and the plating, so
 * its bottom rises with the forefoot.
 */
function buildSpaceGeometry(def: SpaceDef, form: HullForm, cutZ: number): THREE.BufferGeometry {
  const { minX, maxX, minY, maxY, minZ, maxZ } = def.aabb
  if (def.kind === 'room') {
    const geometry = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ)
    geometry.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
    return geometry
  }
  const stations = 28
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= stations; i++) {
    const x = minX + ((maxX - minX) * i) / stations
    const u = Math.min(1, Math.max(0, (x + form.principal.loa / 2) / form.principal.loa))
    const bottom = hullBottomYSim(form, u, cutZ)
    positions.push(x, bottom, minZ, x, bottom, maxZ, x, maxY, minZ, x, maxY, maxZ)
  }
  for (let i = 0; i < stations; i++) {
    const a = i * 4
    const b = (i + 1) * 4
    indices.push(a, b, a + 1, b, b + 1, a + 1)
    indices.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2)
    indices.push(a, a + 2, b, a + 2, b + 2, b)
    indices.push(a + 1, b + 1, a + 3, b + 3, a + 3, a + 1)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// ---------------------------------------------------------------- the scene

export function buildYachtScene(options: YachtSceneOptions): YachtScene {
  const { form, spaces, cutZ } = options
  const group = new THREE.Group()
  const disposables: { dispose: () => void }[] = []
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x)
    return x
  }
  const dot = makeDotTexture()
  disposables.push(dot)

  let camera: THREE.Camera | null = null

  // ------------------------------------------------------------------ the hull
  const hull = buildHullGeometry(form, cutZ)
  const shell = new THREE.Mesh(
    track(hull.shell),
    new THREE.MeshPhongMaterial({
      color: COLOURS.hull,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
      depthWrite: false,
      shininess: 90,
      specular: 0x4fd1c5,
    }),
  )
  group.add(shell)
  group.add(
    new THREE.LineSegments(
      track(new THREE.WireframeGeometry(hull.shell)),
      new THREE.LineBasicMaterial({ color: COLOURS.hullEdge, transparent: true, opacity: 0.3 }),
    ),
  )
  group.add(
    new THREE.Mesh(
      track(hull.profileRibbon),
      new THREE.MeshBasicMaterial({
        color: COLOURS.plating,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
      }),
    ),
  )
  group.add(
    new THREE.Line(
      track(hull.profileCurve),
      new THREE.LineBasicMaterial({ color: COLOURS.profile, transparent: true, opacity: 0.95 }),
    ),
  )
  group.add(
    new THREE.Line(
      track(hull.sheerLine),
      new THREE.LineBasicMaterial({ color: COLOURS.hullEdge, transparent: true, opacity: 0.7 }),
    ),
  )

  // ----------------------------------------------------------------- the sea
  const sea = new THREE.Mesh(
    track(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({
      color: 0x06121a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  )
  sea.position.y = form.principal.draft - form.baselineOffsetM
  group.add(sea)

  // ----------------------------------------------------------------- the spaces
  const spaceVisuals = new Map<
    string,
    {
      mesh: THREE.Mesh
      edges: THREE.LineSegments
      label: THREE.Sprite
      def: SpaceDef
      /** The text the label is currently showing, so it is not rebuilt for nothing. */
      text: string
    }
  >()

  for (const s of spaces) {
    const geometry = track(buildSpaceGeometry(s, form, cutZ))
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: COLOURS.void,
        transparent: true,
        opacity: 0.07,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    group.add(mesh)
    const edges = new THREE.LineSegments(
      track(new THREE.EdgesGeometry(geometry)),
      new THREE.LineBasicMaterial({ color: COLOURS.void, transparent: true, opacity: 0.85 }),
    )
    group.add(edges)
    const label = makeLabel(s.name, COLOURS.void, 0.42)
    label.position.set(
      (s.aabb.minX + s.aabb.maxX) / 2,
      s.aabb.maxY + 0.62,
      (s.aabb.minZ + s.aabb.maxZ) / 2,
    )
    group.add(label)
    spaceVisuals.set(s.id, { mesh, edges, label, def: s, text: s.name })
  }

  // ----------------------------------------------------------------- the deck
  const DECK_Y0 = 1.36
  const DECK_Y1 = 1.46
  const hatchXs = [2.8, 3.2, 5.7, 6.1] as const
  const slotZ0 = 0.55
  const slotZ1 = 0.75
  const deckMinX = 1.2
  const deckMaxX = 6.5
  const deckHalfZ = 2.465

  const deckMaterial = new THREE.MeshBasicMaterial({
    color: 0x4a5a6b,
    transparent: true,
    opacity: 0.09,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const deckPanel = (
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): void => {
    const geometry = track(new THREE.BoxGeometry(maxX - minX, DECK_Y1 - DECK_Y0, maxZ - minZ))
    geometry.translate((minX + maxX) / 2, (DECK_Y0 + DECK_Y1) / 2, (minZ + maxZ) / 2)
    group.add(new THREE.Mesh(geometry, deckMaterial))
  }
  deckPanel(deckMinX, deckMaxX, -deckHalfZ, slotZ0)
  deckPanel(deckMinX, deckMaxX, slotZ1, deckHalfZ)
  deckPanel(deckMinX, hatchXs[0], slotZ0, slotZ1)
  deckPanel(hatchXs[1], hatchXs[2], slotZ0, slotZ1)
  deckPanel(hatchXs[3], deckMaxX, slotZ0, slotZ1)

  for (const hx of [3.0, 5.9]) {
    const hole = new THREE.Mesh(
      track(new THREE.BoxGeometry(0.4, DECK_Y1 - DECK_Y0, slotZ1 - slotZ0)),
      new THREE.MeshBasicMaterial({
        color: COLOURS.voidUnreachable,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    )
    hole.position.set(hx, (DECK_Y0 + DECK_Y1) / 2, (slotZ0 + slotZ1) / 2)
    group.add(hole)
  }

  // ------------------------------------------------------------- the coverage
  const MAX_POINTS = 60000
  const coverageGeometry = track(new THREE.BufferGeometry())
  const coveragePositions = new Float32Array(MAX_POINTS * 3)
  const coverageColours = new Float32Array(MAX_POINTS * 3)
  coverageGeometry.setAttribute('position', new THREE.BufferAttribute(coveragePositions, 3))
  coverageGeometry.setAttribute('color', new THREE.BufferAttribute(coverageColours, 3))
  coverageGeometry.setDrawRange(0, 0)
  const coveragePoints = new THREE.Points(
    coverageGeometry,
    track(
      new THREE.PointsMaterial({
        size: 0.2,
        map: dot,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
        sizeAttenuation: true,
      }),
    ),
  )
  coveragePoints.frustumCulled = false
  coveragePoints.renderOrder = 6
  group.add(coveragePoints)

  const volumetricGeometry = track(new THREE.BufferGeometry())
  const volumetricPositions = new Float32Array(8000 * 3)
  const volumetricColours = new Float32Array(8000 * 3)
  volumetricGeometry.setAttribute('position', new THREE.BufferAttribute(volumetricPositions, 3))
  volumetricGeometry.setAttribute('color', new THREE.BufferAttribute(volumetricColours, 3))
  volumetricGeometry.setDrawRange(0, 0)
  const volumetricPoints = new THREE.Points(
    volumetricGeometry,
    track(
      new THREE.PointsMaterial({
        size: 0.3,
        map: dot,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
        sizeAttenuation: true,
      }),
    ),
  )
  volumetricPoints.frustumCulled = false
  volumetricPoints.renderOrder = 6
  group.add(volumetricPoints)

  // ---------------------------------------------------------------- the agents
  type AgentVisual = {
    readonly cls: string
    readonly body: THREE.Group
    readonly beacon: THREE.Sprite
    readonly label: THREE.Sprite
    readonly reticle: THREE.Group
    readonly cone: THREE.Mesh | null
    readonly rotor: THREE.Object3D | null
    readonly trail: Trail
    readonly pings: Ping[]
    pingClock: number
    lastX: number
    lastY: number
    lastZ: number
  }
  const agentVisuals = new Map<string, AgentVisual>()

  // -- ground-01: a 340 mm rover with a spinning lidar puck and a light fan.
  const groundBody = new THREE.Group()
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.09, 0.3),
    new THREE.MeshBasicMaterial({ color: 0x16323a }),
  )
  chassis.position.y = 0.055
  groundBody.add(chassis)
  const beaconPost = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.05),
    new THREE.MeshBasicMaterial({ color: COLOURS.agentGround }),
  )
  beaconPost.position.y = 0.125
  groundBody.add(beaconPost)
  for (const [dx, dz] of [
    [-0.14, -0.12],
    [0.14, -0.12],
    [-0.14, 0.12],
    [0.14, 0.12],
  ] as const) {
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10).rotateZ(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x0a0f14 }),
    )
    wheel.position.set(dx, 0.045, dz)
    groundBody.add(wheel)
  }
  const lidar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12),
    new THREE.MeshBasicMaterial({ color: 0xa8fff0 }),
  )
  lidar.position.y = 0.17
  groundBody.add(lidar)

  // -- hover-01: a 240 mm quad with four rotors and a downward light cone.
  const hoverBody = new THREE.Group()
  hoverBody.add(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.045, 16),
      new THREE.MeshBasicMaterial({ color: 0x1c3b2a }),
    ),
  )
  const rotor = new THREE.Group()
  for (const [dx, dz] of [
    [0.1, 0.1],
    [-0.1, 0.1],
    [0.1, -0.1],
    [-0.1, -0.1],
  ] as const) {
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.012, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x2c5540 }),
    )
    arm.position.set(dx / 2, 0, dz / 2)
    arm.rotation.y = Math.atan2(dz, dx)
    rotor.add(arm)
    const disc = new THREE.Mesh(
      new THREE.TorusGeometry(0.05, 0.008, 6, 14).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: COLOURS.agentHover,
        transparent: true,
        opacity: 0.9,
      }),
    )
    disc.position.set(dx, 0.01, dz)
    rotor.add(disc)
  }
  rotor.position.y = 0.02
  hoverBody.add(rotor)

  // -- inch-01: an 80 mm crawler. It lives inside a 60 mm bore, so what the
  //    viewer sees is its light, not its body.
  const crawlerBody = new THREE.Group()
  crawlerBody.add(
    new THREE.Mesh(
      new THREE.CapsuleGeometry(0.035, 0.06, 4, 10).rotateZ(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COLOURS.agentCrawler }),
    ),
  )
  crawlerBody.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xfff2d0 }),
    ),
  )

  const bodies: Record<string, THREE.Group> = {
    ground: groundBody,
    inchworm: crawlerBody,
    hover: hoverBody,
  }
  const names: Record<string, string> = {
    ground: 'ground-01',
    inchworm: 'inch-01',
    hover: 'hover-01',
  }
  const colours: Record<string, number> = {
    ground: COLOURS.agentGround,
    inchworm: COLOURS.agentCrawler,
    hover: COLOURS.agentHover,
  }

  for (const [cls, body] of Object.entries(bodies)) {
    group.add(body)
    const beacon = makeGlow(colours[cls] ?? 0xffffff, 1.0)
    group.add(beacon)
    const label = makeLabel(names[cls] ?? cls, colours[cls] ?? 0xffffff, 0.4)
    group.add(label)

    // The lock-on reticle: a ring and four ticks, scaled with distance so it
    // covers the same fraction of the screen wherever the robot is.
    const reticle = new THREE.Group()
    // Flat on the ground. A ring is born in the XY plane, which means it stands
    // up like a hoop; it has to be laid down or it reads as a vertical arch
    // floating over the machine.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: colours[cls] ?? 0xffffff,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    reticle.add(ring)
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      // A flat box rather than a plane, so it lies on the ground whatever
      // its orientation.
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.02, 0.05),
        new THREE.MeshBasicMaterial({
          color: colours[cls] ?? 0xffffff,
          transparent: true,
          opacity: 0.9,
          depthTest: false,
          depthWrite: false,
        }),
      )
      tick.position.set(Math.cos(a) * 1.18, 0, Math.sin(a) * 1.18)
      tick.rotation.y = -a
      reticle.add(tick)
    }
    reticle.renderOrder = 12
    group.add(reticle)

    // The sensing cone. The rover's depth fan spreads on the sole; the hover's
    // light comes straight down.
    let cone: THREE.Mesh | null = null
    if (cls === 'ground') {
      // The depth sensor's fan, spreading on the sole: three metres, which is
      // the range the agent actually has.
      cone = new THREE.Mesh(
        new THREE.ConeGeometry(3.0, 0.32, 32, 1, true),
        new THREE.MeshBasicMaterial({
          color: COLOURS.agentGround,
          transparent: true,
          opacity: 0.06,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      )
      cone.position.y = 0.06
    } else if (cls === 'hover') {
      cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.9, 1.1, 24, 1, true),
        new THREE.MeshBasicMaterial({
          color: COLOURS.agentHover,
          transparent: true,
          opacity: 0.09,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      )
      cone.position.y = -0.55
      cone.rotation.x = Math.PI
    } else {
      // The crawler's bore light: a short tube along its heading.
      cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.055, 0.7, 12, 1, true).rotateZ(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: COLOURS.agentCrawler,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      )
      cone.position.x = 0.34
    }
    // The cone is a CHILD of the body, so it travels with the machine. Added
    // to the scene it sat at the origin and never moved, which made the sensing
    // footprint look like a stray glow in the middle of the boat.
    if (cone !== null) body.add(cone)

    const trail = new Trail(colours[cls] ?? 0xffffff, cls === 'inchworm' ? 0.05 : 0.075, 900)
    group.add(trail.object)

    const pings: Ping[] = []
    for (let i = 0; i < 3; i++) {
      const ping = new Ping(colours[cls] ?? 0xffffff, 1.1)
      group.add(ping.mesh)
      pings.push(ping)
    }

    agentVisuals.set(cls, {
      cls,
      body,
      beacon,
      label,
      reticle,
      cone,
      rotor: cls === 'hover' ? rotor : cls === 'ground' ? lidar : null,
      trail,
      pings,
      pingClock: 0,
      lastX: Number.NaN,
      lastY: 0,
      lastZ: 0,
    })
  }

  // ----------------------------------------------------------------- the human
  const reaching = makeReachingPerson(COLOURS.human)
  reaching.position.set(3.0, DECK_Y1, cutZ)
  group.add(reaching)
  const reachTag = makeLabel('a person can reach in here', COLOURS.human, 0.44)
  reachTag.position.set(3.0, DECK_Y1 + 1.25, cutZ)
  group.add(reachTag)

  const holeTag = makeLabel('200 mm clear', COLOURS.voidUnreachable, 0.4)
  holeTag.position.set(3.0, DECK_Y1 + 0.35, cutZ)
  group.add(holeTag)

  const roomSpace = spaces.find((s) => s.kind === 'room')
  if (roomSpace !== undefined) {
    const human = makeHuman(1.8, COLOURS.human)
    human.position.set((roomSpace.aabb.minX + roomSpace.aabb.maxX) / 2, roomSpace.aabb.minY, 0.6)
    human.scale.setScalar(0.92)
    group.add(human)
  }

  // --------------------------------------------------------- findings and truth
  const findingGroup = new THREE.Group()
  group.add(findingGroup)
  const jobGroup = new THREE.Group()
  group.add(jobGroup)
  const truthGroup = new THREE.Group()
  group.add(truthGroup)

  // The visuals that persist between frames. Built once, moved thereafter.
  const findingVisuals = new Map<
    string,
    { mesh: THREE.Mesh; glow: THREE.Sprite; label: THREE.Sprite }
  >()
  const jobVisuals = new Map<string, THREE.Mesh>()
  const truthVisuals = new Map<string, { mesh: THREE.Mesh; glow: THREE.Sprite }>()
  let truthBuilt = false

  const base = new THREE.Color(COLOURS.coverage)
  const hot = new THREE.Color(COLOURS.coverageHot)
  let findingIndex = 0

  function spaceExamined(frame: SimFrame, def: SpaceDef): boolean {
    if (def.kind === 'room') {
      let seen = 0
      let total = 0
      const cx0 = Math.floor((def.aabb.minX - frame.bounds.minX) / frame.cellSize)
      const cx1 = Math.floor((def.aabb.maxX - frame.bounds.minX) / frame.cellSize)
      const cz0 = Math.floor((def.aabb.minZ - frame.bounds.minZ) / frame.cellSize)
      const cz1 = Math.floor((def.aabb.maxZ - frame.bounds.minZ) / frame.cellSize)
      for (let cz = Math.max(0, cz0); cz <= Math.min(frame.gridHeight - 1, cz1); cz++) {
        for (let cx = Math.max(0, cx0); cx <= Math.min(frame.gridWidth - 1, cx1); cx++) {
          const i = cz * frame.gridWidth + cx
          if (frame.passable[i] !== 1) continue
          total++
          if (frame.observed[i]! >= 2) seen++
        }
      }
      return total > 0 && seen / total > 0.05
    }
    for (const raster of frame.rasters) {
      const rx0 = Math.floor((def.aabb.minX - raster.minX) / raster.cellSizeM)
      const rx1 = Math.floor((def.aabb.maxX - raster.minX) / raster.cellSizeM)
      const rz0 = Math.floor((def.aabb.minZ - raster.minZ) / raster.cellSizeM)
      const rz1 = Math.floor((def.aabb.maxZ - raster.minZ) / raster.cellSizeM)
      for (let rz = Math.max(0, rz0); rz <= Math.min(raster.depth - 1, rz1); rz++) {
        for (let rx = Math.max(0, rx0); rx <= Math.min(raster.width - 1, rx1); rx++) {
          if ((raster.observations[rz * raster.width + rx] ?? 0) > 0) return true
        }
      }
    }
    return false
  }

  function setFrame(frame: SimFrame, elapsed: number): void {
    // -- spaces: lit if examined, dark if not.
    for (const [, v] of spaceVisuals) {
      const examined = spaceExamined(frame, v.def)
      const colour = examined ? COLOURS.void : COLOURS.voidUnreachable
      const material = v.mesh.material as THREE.MeshBasicMaterial
      material.color.setHex(colour)
      material.opacity = examined ? 0.11 : 0.05
      const edgeMaterial = v.edges.material as THREE.LineBasicMaterial
      edgeMaterial.color.setHex(colour)
      edgeMaterial.opacity = examined ? 0.85 : 1
      // The label is only rebuilt when its TEXT changes.
      //
      // `makeLabel` draws a canvas and uploads a texture. Doing it for every
      // space on every frame — sixty times a second, for a word that changes
      // twice in a run — is a hundred canvas allocations a second and a texture
      // upload each one, and it was the largest single source of frame-time
      // variance in the scene. A stutter that comes and goes with the picture
      // is almost always this.
      const text = examined ? v.def.name : `${v.def.name} — UNREACHABLE`
      if (text !== v.text) {
        v.text = text
        const label = makeLabel(text, examined ? COLOURS.void : COLOURS.voidUnreachable, 0.42)
        v.label.material.map?.dispose()
        v.label.material.map = label.material.map
        v.label.material.needsUpdate = true
      }
    }

    // -- the coverage field.
    let n = 0
    for (let cz = 0; cz < frame.gridHeight && n < MAX_POINTS; cz++) {
      for (let cx = 0; cx < frame.gridWidth && n < MAX_POINTS; cx++) {
        const i = cz * frame.gridWidth + cx
        const count = frame.observed[i]!
        if (count < 2) continue
        coveragePositions[n * 3] = frame.bounds.minX + (cx + 0.5) * frame.cellSize
        coveragePositions[n * 3 + 1] = 0.04
        coveragePositions[n * 3 + 2] = frame.bounds.minZ + (cz + 0.5) * frame.cellSize
        const t = Math.min(1, (count - 2) / 5)
        const c = base.clone().lerp(hot, t).multiplyScalar(0.16 + t * 0.42)
        coverageColours[n * 3] = c.r
        coverageColours[n * 3 + 1] = c.g
        coverageColours[n * 3 + 2] = c.b
        n++
      }
    }
    coverageGeometry.setDrawRange(0, n)
    coverageGeometry.getAttribute('position').needsUpdate = true
    coverageGeometry.getAttribute('color').needsUpdate = true

    // -- the volumetric field, coloured by the thermal deviation.
    let m = 0
    for (const raster of frame.rasters) {
      for (let rz = 0; rz < raster.depth && m < 8000; rz++) {
        for (let rx = 0; rx < raster.width && m < 8000; rx++) {
          const obs = raster.observations[rz * raster.width + rx] ?? 0
          if (obs < 2) continue
          volumetricPositions[m * 3] = raster.minX + (rx + 0.5) * raster.cellSizeM
          volumetricPositions[m * 3 + 1] = 1.2
          volumetricPositions[m * 3 + 2] = raster.minZ + (rz + 0.5) * raster.cellSizeM
          const dev = raster.meanDeviationK[rz * raster.width + rx] ?? 0
          const t = Math.min(1, Math.abs(dev) / 4)
          const c =
            dev >= 0
              ? base.clone().lerp(new THREE.Color(0xffb454), t)
              : base.clone().lerp(new THREE.Color(0x63b3ed), t)
          c.multiplyScalar(0.14 + t * 0.4)
          volumetricColours[m * 3] = c.r
          volumetricColours[m * 3 + 1] = c.g
          volumetricColours[m * 3 + 2] = c.b
          m++
        }
      }
    }
    volumetricGeometry.setDrawRange(0, m)
    volumetricGeometry.getAttribute('position').needsUpdate = true
    volumetricGeometry.getAttribute('color').needsUpdate = true

    // -- the agents.
    for (const a of frame.agents) {
      const v = agentVisuals.get(a.cls)
      if (v === undefined) continue
      v.body.position.set(a.x, a.y, a.z)
      v.body.rotation.y = -a.heading
      v.beacon.position.set(a.x, a.y + 0.3, a.z)
      v.label.position.set(a.x, a.y + 0.75, a.z)
      if (v.rotor !== null) v.rotor.rotation.y = elapsed * (v.cls === 'hover' ? 22 : 3.5)

      // The reticle scales with distance, so it covers the same fraction of the
      // screen at any range. A marker of fixed world size is either invisible
      // at thirty metres or enormous at four.
      if (camera !== null) {
        const d = camera.position.distanceTo(v.body.position)
        v.reticle.position.set(a.x, a.y + 0.02, a.z)
        v.reticle.scale.setScalar(Math.max(0.12, d * 0.055))
        v.reticle.visible = d > 0.8
      }


    }

    // -- the findings.
    //
    // Built once and then MOVED, rather than destroyed and rebuilt every frame.
    // The first version did the latter: eight findings times a mesh, a canvas
    // texture and a sprite, sixty times a second. Eight hundred canvas
    // allocations a second is not a frame budget, it is a stall.
    const seenFindings = new Set<string>()
    findingIndex = 0
    for (const f of frame.findings) {
      seenFindings.add(f.id)
      let v = findingVisuals.get(f.id)
      if (v === undefined) {
        const mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.16, 0),
          new THREE.MeshBasicMaterial({ color: COLOURS.finding, transparent: true, opacity: 0.95 }),
        )
        const glow = makeGlow(COLOURS.finding, 0.9)
        const label = makeLabel(f.detectorId, COLOURS.finding, 0.3)
        findingGroup.add(mesh)
        findingGroup.add(glow)
        findingGroup.add(label)
        v = { mesh, glow, label }
        findingVisuals.set(f.id, v)
      }
      v.mesh.position.set(f.x, 0.35, f.z)
      v.glow.position.set(f.x, 0.35, f.z)
      v.label.position.set(f.x, 0.8 + (findingIndex % 4) * 0.42, f.z)
      findingIndex++
    }
    for (const [id, v] of findingVisuals) {
      if (seenFindings.has(id)) continue
      findingGroup.remove(v.mesh)
      findingGroup.remove(v.glow)
      findingGroup.remove(v.label)
      v.mesh.geometry.dispose()
      findingVisuals.delete(id)
    }

    // -- the jobs.
    //
    // Twenty-one jobs, each a torus geometry, rebuilt sixty times a second.
    const seenJobs = new Set<string>()
    for (const j of frame.jobs) {
      seenJobs.add(j.id)
      let ring = jobVisuals.get(j.id)
      if (ring === undefined) {
        ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.24, 0.02, 6, 20),
          new THREE.MeshBasicMaterial({ color: COLOURS.void, transparent: true, opacity: 0.6 }),
        )
        ring.rotation.x = Math.PI / 2
        jobGroup.add(ring)
        jobVisuals.set(j.id, ring)
      }
      ring.position.set(j.x, 0.06, j.z)
    }
    for (const [id, ring] of jobVisuals) {
      if (seenJobs.has(id)) continue
      jobGroup.remove(ring)
      ring.geometry.dispose()
      jobVisuals.delete(id)
    }

    // -- the truth overlay.
    //
    // The oracle does not change during a run, so this is built once.
    if (truthBuilt) {
      for (let i = 0; i < frame.truth.length; i++) {
        const t = frame.truth[i]!
        const v = truthVisuals.get(String(i))
        if (v === undefined) continue
        v.mesh.position.set(t.x, t.y, t.z)
        v.glow.position.set(t.x, t.y, t.z)
      }
    } else {
      truthBuilt = true
      for (let i = 0; i < frame.truth.length; i++) {
        const t = frame.truth[i]!
        const mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.2, 0),
          new THREE.MeshBasicMaterial({
            color: COLOURS.truth,
            wireframe: true,
            transparent: true,
            opacity: 0.95,
          }),
        )
        mesh.position.set(t.x, t.y, t.z)
        truthGroup.add(mesh)
        const glow = makeGlow(COLOURS.truth, 0.85)
        glow.position.set(t.x, t.y, t.z)
        truthGroup.add(glow)
        truthVisuals.set(String(i), { mesh, glow })
      }
    }

    // -- the pings. Each agent pings on its own cadence, and the ring is the
    //    only thing in the scene that says "this machine is alive right now".
    for (const [, v] of agentVisuals) {
      v.pingClock += 1 / 60
      if (v.pingClock > 1.4) {
        v.pingClock = 0
        const ping = v.pings.find((p) => !p.mesh.visible)
        if (ping !== undefined) {
          const a = frame.agents.find((x) => x.cls === v.cls)
          if (a !== undefined) ping.fire(a.x, a.y + 0.05, a.z, 0.3)
        }
      }
      for (const p of v.pings) p.update(1 / 60)
    }

  }

  function setTrailPoints(frame: SimFrame): void {
    for (const a of frame.agents) {
      const v = agentVisuals.get(a.cls)
      if (v === undefined) continue
      v.trail.push(a.x, a.y + 0.03, a.z, a.cls === 'inchworm' ? 0.05 : 0.12)
      v.lastX = a.x
      v.lastY = a.y
      v.lastZ = a.z
    }
  }

  return {
    group,
    setCamera: (c: THREE.Camera) => {
      camera = c
    },
    setFrame,
    setTrailPoints,
    dispose: () => {
      for (const d of disposables) d.dispose()
      group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry !== undefined) mesh.geometry.dispose()
      })
    },
  }
}
