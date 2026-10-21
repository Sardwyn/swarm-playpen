/**
 * The yacht scene, driven by simulation frames.
 *
 * ## What this draws
 *
 * The boat, cut open, with the swarm's coverage drawn *into* it as light.
 *
 * The hull is a ghost — a cage of lines rather than a solid — because the subject
 * is what is inside the boat and a solid hull hides exactly that. The light is the
 * subject: the coverage blooms behind the agents as they work, the engine room fills
 * up, and the forward stringer void stays black.
 *
 * ## The one image the whole project is for
 *
 * A person stands in the stringer void, because a person *can* get in there and
 * nothing in the swarm can. That is the product statement as a picture, and no
 * amount of text does it as fast.
 *
 * ## What is on screen
 *
 * - the **coverage** as a bloom of light, one point per examined cell, brighter the
 *   more times it has been looked at
 * - the **volumetric coverage** — the hover bot's raster — as a second field
 * - the **spaces**: the engine room and the two volumes above it, with the one the
 *   swarm could not reach drawn dark and edged in red
 * - the **agents**, at true scale, each with a beacon and a sensing footprint
 * - the **findings**, each carrying its detector ID, and the **truth** overlay
 *
 * Nothing here is a measurement. The coverage comes from the frame. The reachability
 * comes from the frame. The geometry comes from the content, whose assumptions are
 * printed in the panel.
 */

import * as THREE from 'three'
import type { SimFrame } from '../sim/report/frame.ts'
import { buildHullGeometry } from './hull.ts'
import { hullBottomY } from '../sim/world/yacht-form.ts'
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
  compartment: 0x3b5a7a,
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
  setFrame(frame: SimFrame): void
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
  // With size attenuation off, the scale is a fraction of the viewport height, so
  // the label is the same size on screen wherever the camera is.
  const h = 0.032 * scale
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

// ---------------------------------------------------------------- the human

/**
 * A human figure, for scale.
 *
 * Built from capsules, and deliberately not a character: it is a ruler. Its whole
 * job is to make the aperture arithmetic visible — a person is 1.8 m and fits
 * through 200 mm; the ground bot is 340 mm across and does not.
 */
function makeHuman(heightM: number, colour: number): THREE.Group {
  const g = new THREE.Group()
  const material = new THREE.MeshBasicMaterial({
    color: colour,
    transparent: true,
    opacity: 0.34,
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
 * its bottom rises with the forefoot. A flat box pokes out through the hull
 * forward of the deepest point, which reads as a box lying outside the boat.
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
    const bottom = hullBottomY(form, u, cutZ)
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

  // -------------------------------------------------------------- the sea
  // A plane at the waterline, so the boat is in a place rather than in a void.
  const sea = new THREE.Mesh(
    track(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({
      color: 0x06121a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  )
  sea.position.y = form.principal.draft - 1.75
  group.add(sea)

  // ----------------------------------------------------------------- the spaces
  const spaceVisuals = new Map<
    string,
    { mesh: THREE.Mesh; edges: THREE.LineSegments; label: THREE.Sprite; def: SpaceDef }
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
    const label = makeLabel(s.name, COLOURS.void, 0.46)
    label.position.set(
      (s.aabb.minX + s.aabb.maxX) / 2,
      s.aabb.maxY + 0.24,
      (s.aabb.minZ + s.aabb.maxZ) / 2,
    )
    group.add(label)
    spaceVisuals.set(s.id, { mesh, edges, label, def: s })
  }

  // ------------------------------------------------------------- the coverage
  // A field of light, not a lattice: one point per examined cell, brighter the more
  // times it has been looked at. Additive blending, so unexamined space is simply
  // not there, which is the honest rendering of "not examined".
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

  // The volumetric coverage: the hover bot's raster, at the deckhead height.
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
  const agentVisuals = new Map<
    string,
    { body: THREE.Group; beacon: THREE.Sprite; label: THREE.Sprite; fov: THREE.Mesh | null }
  >()

  const groundBody = new THREE.Group()
  const gBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.1, 0.3),
    new THREE.MeshBasicMaterial({ color: COLOURS.agentGround }),
  )
  gBody.position.y = 0.05
  groundBody.add(gBody)
  const gTop = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.03, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x07090c }),
  )
  gTop.position.y = 0.115
  groundBody.add(gTop)

  const crawlerBody = new THREE.Group()
  crawlerBody.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 12, 8),
      new THREE.MeshBasicMaterial({ color: COLOURS.agentCrawler }),
    ),
  )

  const hoverBody = new THREE.Group()
  hoverBody.add(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 0.05, 16),
      new THREE.MeshBasicMaterial({ color: COLOURS.agentHover }),
    ),
  )
  for (const [dx, dz] of [
    [0.13, 0.13],
    [-0.13, 0.13],
    [0.13, -0.13],
    [-0.13, -0.13],
  ] as const) {
    const rotor = new THREE.Mesh(
      new THREE.TorusGeometry(0.07, 0.012, 6, 16),
      new THREE.MeshBasicMaterial({ color: COLOURS.agentHover, transparent: true, opacity: 0.85 }),
    )
    rotor.rotation.x = Math.PI / 2
    rotor.position.set(dx, 0, dz)
    hoverBody.add(rotor)
  }

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

  for (const [cls, body] of Object.entries(bodies)) {
    group.add(body)
    const beacon = makeGlow(cls === 'ground' ? COLOURS.agentGround : cls === 'inchworm' ? COLOURS.agentCrawler : COLOURS.agentHover, 1.1)
    group.add(beacon)
    const label = makeLabel(names[cls] ?? cls, 0xffffff, 0.4)
    group.add(label)
    // The sensing footprint, so the coverage has a visible cause.
    let fov: THREE.Mesh | null = null
    if (cls !== 'hover') {
      const r = cls === 'ground' ? 3.0 : 0.4
      fov = new THREE.Mesh(
        new THREE.CircleGeometry(r, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: cls === 'ground' ? COLOURS.agentGround : COLOURS.agentCrawler,
          transparent: true,
          opacity: 0.028,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      group.add(fov)
    }
    agentVisuals.set(cls, { body, beacon, label, fov })
  }

  // ----------------------------------------------------------------- the human
  // A person in the stringer void, because a person can get in there and nothing
  // in the swarm can. And one in the engine room, for scale.
  const voidSpace = spaces.find((s) => s.id === 'stringer-fwd')
  if (voidSpace !== undefined) {
    const u = Math.min(1, Math.max(0, ((voidSpace.aabb.minX + voidSpace.aabb.maxX) / 2 + form.principal.loa / 2) / form.principal.loa))
    const floor = hullBottomY(form, u, cutZ)
    const human = makeHuman(1.8, COLOURS.human)
    human.position.set((voidSpace.aabb.minX + voidSpace.aabb.maxX) / 2, floor, cutZ)
    group.add(human)
    const tag = makeLabel('a person fits in here', COLOURS.human, 0.46)
    tag.position.set(
      (voidSpace.aabb.minX + voidSpace.aabb.maxX) / 2,
      floor + 2.1,
      cutZ,
    )
    group.add(tag)
  }

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

  const dummy = new THREE.Object3D()
  const base = new THREE.Color(COLOURS.coverage)
  const hot = new THREE.Color(COLOURS.coverageHot)

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

  function setFrame(frame: SimFrame): void {
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
      const text = examined ? v.def.name : `${v.def.name} — UNREACHABLE`
      const label = makeLabel(text, examined ? COLOURS.void : COLOURS.voidUnreachable, 0.46)
      v.label.material.map?.dispose()
      v.label.material.map = label.material.map
      v.label.material.needsUpdate = true
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

    // -- the volumetric field.
    let m = 0
    for (const raster of frame.rasters) {
      for (let rz = 0; rz < raster.depth && m < 8000; rz++) {
        for (let rx = 0; rx < raster.width && m < 8000; rx++) {
          const obs = raster.observations[rz * raster.width + rx] ?? 0
          if (obs < 2) continue
          volumetricPositions[m * 3] = raster.minX + (rx + 0.5) * raster.cellSizeM
          volumetricPositions[m * 3 + 1] = 1.2
          volumetricPositions[m * 3 + 2] = raster.minZ + (rz + 0.5) * raster.cellSizeM
          const t = Math.min(1, (obs - 2) / 5)
          const c = base.clone().lerp(hot, t).multiplyScalar(0.14 + t * 0.36)
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

    // -- the agents, with their beacons and their sensing footprints.
    for (const a of frame.agents) {
      const v = agentVisuals.get(a.cls)
      if (v === undefined) continue
      v.body.position.set(a.x, a.y, a.z)
      v.body.rotation.y = -a.heading
      v.beacon.position.set(a.x, a.y + 0.35, a.z)
      v.label.position.set(a.x, a.y + 0.8, a.z)
      if (v.fov !== null) {
        v.fov.position.set(a.x, a.y + 0.02, a.z)
      }
    }

    // -- the findings.
    for (const child of [...findingGroup.children]) {
      findingGroup.remove(child)
      ;(child as THREE.Mesh).geometry?.dispose()
    }
    for (const f of frame.findings) {
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.16, 0),
        new THREE.MeshBasicMaterial({ color: COLOURS.finding, transparent: true, opacity: 0.95 }),
      )
      mesh.position.set(f.x, 0.35, f.z)
      findingGroup.add(mesh)
      const glow = makeGlow(COLOURS.finding, 0.9)
      glow.position.set(f.x, 0.35, f.z)
      findingGroup.add(glow)
      const label = makeLabel(f.detectorId, COLOURS.finding, 0.36)
      label.position.set(f.x, 0.75, f.z)
      findingGroup.add(label)
    }

    // -- the jobs.
    for (const child of [...jobGroup.children]) jobGroup.remove(child)
    for (const j of frame.jobs) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.24, 0.02, 6, 20),
        new THREE.MeshBasicMaterial({ color: COLOURS.void, transparent: true, opacity: 0.6 }),
      )
      ring.rotation.x = Math.PI / 2
      ring.position.set(j.x, 0.06, j.z)
      jobGroup.add(ring)
    }

    // -- the truth overlay: the faults that were there, whether or not anyone saw.
    for (const child of [...truthGroup.children]) truthGroup.remove(child)
    for (const t of frame.truth) {
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
    }
  }

  void dummy
  void base
  void hot

  return {
    group,
    setFrame,
    dispose: () => {
      for (const d of disposables) d.dispose()
      group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry !== undefined) mesh.geometry.dispose()
      })
    },
  }
}
