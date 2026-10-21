/**
 * The yacht scene, driven by simulation frames.
 *
 * ## What this draws
 *
 * The boat, cut open, with the swarm's coverage drawn *into* it.
 *
 * The hull is a ghost, because the subject is what is inside the boat and an
 * opaque hull hides exactly that. Inside it:
 *
 * - the **ground coverage lattice** — every cell the swarm has looked at twice,
 *   as light on the engine room sole, with the rest of the boat dark
 * - the **volumetric coverage** — the hover bot's raster, drawn at the deckhead
 *   height, which is lit over the engine room and dark over the stringer void
 * - the **spaces** — the engine room and the two volumes above it, with the one
 *   the swarm could not reach drawn dark and edged in red
 * - the **agents**, three visibly different bodies with different access
 * - the **findings**, each carrying its detector ID, and the **truth** overlay
 *
 * ## The one number the picture is about
 *
 * The most severe fault on the vessel is in the forward stringer void, and the
 * swarm never gets near it: the void is entered through two 200 mm deck hatches and
 * every agent is wider than that. So the stringer void is drawn dark, and the
 * reason is written on it. A picture where the dark part is the subject is the
 * opposite of every AI demo, and it is the one that sells.
 *
 * ## Nothing here is a measurement
 *
 * The coverage comes from the frame. The reachability comes from the frame. The
 * geometry comes from the content, whose assumptions are printed in the panel.
 */

import * as THREE from 'three'
import type { SimFrame } from '../sim/report/frame.ts'
import { buildHullGeometry, hullSurfaceBelow } from './hull.ts'
import { hullBottomY } from '../sim/world/yacht-form.ts'
import type { HullForm } from '../sim/world/yacht-form.ts'

const COLOURS = {
  bg: 0x0d1117,
  hull: 0x1b2430,
  hullEdge: 0x30363d,
  plating: 0x39424f,
  profile: 0x8fa3b8,
  coverage: 0x4fd1c5,
  coverageDim: 0x2c6f6a,
  void: 0x63b3ed,
  voidUnreachable: 0x6b3030,
  compartment: 0x3b5a7a,
  agentGround: 0x4fd1c5,
  agentCrawler: 0xed8936,
  agentHover: 0x68d391,
  findingConfirmed: 0xf6e05e,
  findingUnverified: 0xed8936,
  truth: 0xb794f4,
  job: 0x63b3ed,
  text: 0xc9d1d9,
  dim: 0x8b949e,
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
  /** The fault classes, for the labels. */
  readonly faultLabels?: ReadonlyMap<string, string>
}

export type YachtScene = {
  readonly group: THREE.Group
  setFrame(frame: SimFrame): void
  dispose(): void
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
  c.fillStyle = 'rgba(13,17,23,0.74)'
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
  sprite.renderOrder = 12
  return sprite
}

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

/**
 * The three agent bodies, as factories.
 *
 * They take the colour as a parameter rather than closing over a destructured
 * loop binding, because an array literal whose arrow functions reference the
 * binding they are being destructured from is a temporal dead zone waiting to
 * happen — and it happened.
 */
function groundBody(colour: number): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.1, 0.3),
    new THREE.MeshBasicMaterial({ color: colour }),
  )
  body.position.y = 0.05
  g.add(body)
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.03, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x0d1117 }),
  )
  top.position.y = 0.115
  g.add(top)
  return g
}

function crawlerBody(colour: number): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 12, 8),
    new THREE.MeshBasicMaterial({ color: colour }),
  )
  g.add(body)
  const glow = makeGlow(colour, 0.5)
  glow.position.y = 0.02
  g.add(glow)
  return g
}

function hoverBody(colour: number): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.13, 0.05, 16),
    new THREE.MeshBasicMaterial({ color: colour }),
  )
  g.add(body)
  const rotorOffsets: readonly (readonly [number, number])[] = [
    [0.13, 0.13],
    [-0.13, 0.13],
    [0.13, -0.13],
    [-0.13, -0.13],
  ]
  for (const [dx, dz] of rotorOffsets) {
    const rotor = new THREE.Mesh(
      new THREE.TorusGeometry(0.07, 0.012, 6, 16),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.8 }),
    )
    rotor.rotation.x = Math.PI / 2
    rotor.position.set(dx, 0, dz)
    g.add(rotor)
  }
  return g
}

/**
 * The geometry of a named space.
 *
 * For a **void** the floor follows the hull, because the void's floor *is* the
 * hull: the stringer void on a boat is the space between the stringers and the
 * plating, so its bottom rises with the forefoot. A flat box pokes out through
 * the hull forward of the deepest point, which reads as a red box lying outside
 * the boat and quietly destroys the point of the picture.
 *
 * For a **room** the floor is flat, because it is a deck.
 */
function buildSpaceGeometry(def: SpaceDef, form: HullForm, cutZ: number): THREE.BufferGeometry {
  const { minX, maxX, minY, maxY, minZ, maxZ } = def.aabb
  const stations = 24
  const positions: number[] = []
  const indices: number[] = []

  if (def.kind === 'room') {
    const geometry = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ)
    geometry.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
    return geometry
  }

  // A void: a prism whose bottom edge is the hull's inner surface at the cut
  // plane, and whose top is the underside of the deck above it.
  for (let i = 0; i <= stations; i++) {
    const x = minX + ((maxX - minX) * i) / stations
    const u = Math.min(1, Math.max(0, (x + form.principal.loa / 2) / form.principal.loa))
    const bottom = hullBottomY(form, u, cutZ)
    positions.push(x, bottom, minZ, x, bottom, maxZ, x, maxY, minZ, x, maxY, maxZ)
  }
  for (let i = 0; i < stations; i++) {
    const a = i * 4
    const b = (i + 1) * 4
    // bottom, top, and the two sides
    indices.push(a, b, a + 1, b, b + 1, a + 1) // bottom
    indices.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2) // top
    indices.push(a, a + 2, b, a + 2, b + 2, b) // near side
    indices.push(a + 1, b + 1, a + 3, b + 3, a + 3, a + 1) // far side
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export function buildYachtScene(options: YachtSceneOptions): YachtScene {
  const { form, spaces, cutZ } = options
  const group = new THREE.Group()
  const disposables: { dispose: () => void }[] = []
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x)
    return x
  }

  // ------------------------------------------------------------------ the hull
  const hull = buildHullGeometry(form, cutZ)
  const shell = new THREE.Mesh(
    track(hull.shell),
    new THREE.MeshPhongMaterial({
      color: COLOURS.hull,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
      shininess: 60,
      specular: 0x4fd1c5,
    }),
  )
  group.add(shell)
  group.add(
    new THREE.LineSegments(
      track(new THREE.WireframeGeometry(hull.shell)),
      new THREE.LineBasicMaterial({ color: COLOURS.hullEdge, transparent: true, opacity: 0.2 }),
    ),
  )
  group.add(
    new THREE.Mesh(
      track(hull.profileRibbon),
      new THREE.MeshBasicMaterial({
        color: COLOURS.plating,
        transparent: true,
        opacity: 0.9,
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
      new THREE.LineBasicMaterial({ color: COLOURS.hullEdge, transparent: true, opacity: 0.5 }),
    ),
  )

  // ----------------------------------------------------------------- the spaces
  // Each space carries a mesh, its edges, and a label. The label's text is set
  // per frame, because whether a space was reached is the point of the picture.
  const spaceVisuals = new Map<
    string,
    {
      mesh: THREE.Mesh
      edges: THREE.LineSegments
      label: THREE.Sprite
      def: SpaceDef
    }
  >()

  for (const s of spaces) {
    const geometry = track(buildSpaceGeometry(s, form, cutZ))
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: COLOURS.void,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    group.add(mesh)
    const edges = new THREE.LineSegments(
      track(new THREE.EdgesGeometry(geometry)),
      new THREE.LineBasicMaterial({ color: COLOURS.void, transparent: true, opacity: 0.7 }),
    )
    group.add(edges)
    const label = makeLabel(s.name, COLOURS.text, 0.44)
    label.position.set(
      (s.aabb.minX + s.aabb.maxX) / 2,
      s.aabb.maxY + 0.2,
      (s.aabb.minZ + s.aabb.maxZ) / 2,
    )
    group.add(label)
    spaceVisuals.set(s.id, { mesh, edges, label, def: s })
  }

  // --------------------------------------------------------- the coverage lattice
  // One instanced quad per observed ground cell. Rebuilt per frame from the
  // frame's observation counts, because the coverage is the subject.
  const lattice = new THREE.InstancedMesh(
    track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    track(new THREE.MeshBasicMaterial({ color: COLOURS.coverage, transparent: true, opacity: 0.9 })),
    40000,
  )
  lattice.count = 0
  lattice.frustumCulled = false
  group.add(lattice)

  // The volumetric coverage: the hover bot's raster, drawn as a sheet at the
  // deckhead height. It is a plan projection, so it is drawn flat — which is
  // honest, because it *is* a plan projection, and the house says so.
  const volumetric = new THREE.InstancedMesh(
    track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    track(new THREE.MeshBasicMaterial({ color: COLOURS.coverage, transparent: true, opacity: 0.45 })),
    4000,
  )
  volumetric.count = 0
  volumetric.frustumCulled = false
  group.add(volumetric)

  // ------------------------------------------------------------------- the agents
  // Three visibly different bodies, because the domain is that they have different
  // access, and a picture where they look the same says nothing.
  const agentMeshes = new Map<string, THREE.Object3D>()
  const agentSpecs: readonly (readonly [string, number, (c: number) => THREE.Group])[] = [
    ['ground', COLOURS.agentGround, groundBody],
    ['inchworm', COLOURS.agentCrawler, crawlerBody],
    ['hover', COLOURS.agentHover, hoverBody],
  ]
  for (const [cls, colour, make] of agentSpecs) {
    const m = make(colour)
    group.add(m)
    agentMeshes.set(cls, m)
  }

  // ---------------------------------------------------------------- the findings
  const findingGroup = new THREE.Group()
  group.add(findingGroup)
  const jobGroup = new THREE.Group()
  group.add(jobGroup)
  const truthGroup = new THREE.Group()
  group.add(truthGroup)

  const dummy = new THREE.Object3D()

  /**
   * Was a space examined?
   *
   * Derived from the frame, not asserted. A ground space is examined when the
   * swarm has looked at its cells; a volumetric space when the hover bot's raster
   * has observations over its footprint. The stringer void has neither, because
   * the swarm never went in and the only apertures are too small.
   */
  function spaceExamined(frame: SimFrame, def: SpaceDef): boolean {
    if (def.kind === 'room') {
      const g = frame
      let seen = 0
      let total = 0
      const cx0 = Math.floor((def.aabb.minX - g.bounds.minX) / g.cellSize)
      const cx1 = Math.floor((def.aabb.maxX - g.bounds.minX) / g.cellSize)
      const cz0 = Math.floor((def.aabb.minZ - g.bounds.minZ) / g.cellSize)
      const cz1 = Math.floor((def.aabb.maxZ - g.bounds.minZ) / g.cellSize)
      for (let cz = Math.max(0, cz0); cz <= Math.min(g.gridHeight - 1, cz1); cz++) {
        for (let cx = Math.max(0, cx0); cx <= Math.min(g.gridWidth - 1, cx1); cx++) {
          const i = cz * g.gridWidth + cx
          if (g.passable[i] !== 1) continue
          total++
          if (g.observed[i]! >= 2) seen++
        }
      }
      return total > 0 && seen / total > 0.05
    }
    // A volumetric space is examined when the raster has looked over it.
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
    // -- spaces: lit if examined, dark if not, and the label says which.
    for (const [, v] of spaceVisuals) {
      const examined = spaceExamined(frame, v.def)
      const colour = examined ? COLOURS.void : COLOURS.voidUnreachable
      const material = v.mesh.material as THREE.MeshBasicMaterial
      material.color.setHex(colour)
      material.opacity = examined ? 0.1 : 0.05
      const edgeMaterial = v.edges.material as THREE.LineBasicMaterial
      edgeMaterial.color.setHex(colour)
      edgeMaterial.opacity = examined ? 0.8 : 0.95
      const text = examined ? v.def.name : `${v.def.name} — UNREACHABLE`
      const label = makeLabel(text, examined ? COLOURS.void : COLOURS.voidUnreachable, 0.44)
      v.label.material.map?.dispose()
      v.label.material.map = label.material.map
      v.label.material.needsUpdate = true
    }

    // -- the ground coverage lattice.
    let n = 0
    for (let cz = 0; cz < frame.gridHeight && n < lattice.count; cz++) {
      for (let cx = 0; cx < frame.gridWidth && n < lattice.count; cx++) {
        const i = cz * frame.gridWidth + cx
        if (frame.observed[i]! < 2) continue
        if (frame.passable[i] !== 1) continue
        dummy.position.set(
          frame.bounds.minX + (cx + 0.5) * frame.cellSize,
          0.012,
          frame.bounds.minZ + (cz + 0.5) * frame.cellSize,
        )
        dummy.scale.set(frame.cellSize * 0.92, 1, frame.cellSize * 0.92)
        dummy.updateMatrix()
        lattice.setMatrixAt(n, dummy.matrix)
        n++
      }
    }
    lattice.count = n
    lattice.instanceMatrix.needsUpdate = true

    // -- the volumetric coverage, at the deckhead height.
    let m = 0
    for (const raster of frame.rasters) {
      for (let rz = 0; rz < raster.depth; rz++) {
        for (let rx = 0; rx < raster.width; rx++) {
          const obs = raster.observations[rz * raster.width + rx] ?? 0
          if (obs < 2) continue
          dummy.position.set(
            raster.minX + (rx + 0.5) * raster.cellSizeM,
            1.18,
            raster.minZ + (rz + 0.5) * raster.cellSizeM,
          )
          dummy.scale.set(raster.cellSizeM * 0.92, 1, raster.cellSizeM * 0.92)
          dummy.updateMatrix()
          volumetric.setMatrixAt(m, dummy.matrix)
          m++
        }
      }
    }
    volumetric.count = m
    volumetric.instanceMatrix.needsUpdate = true

    // -- the agents.
    for (const a of frame.agents) {
      const mesh = agentMeshes.get(a.cls)
      if (mesh === undefined) continue
      mesh.position.set(a.x, a.y, a.z)
      mesh.rotation.y = -a.heading
      mesh.visible = true
    }

    // -- the findings.
    for (const child of [...findingGroup.children]) {
      findingGroup.remove(child)
      const m2 = child as THREE.Mesh
      m2.geometry?.dispose()
    }
    for (const f of frame.findings) {
      const colour = f.status === 'confirmed' ? COLOURS.findingConfirmed : COLOURS.findingUnverified
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.14, 0),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.95 }),
      )
      mesh.position.set(f.x, 0.3, f.z)
      findingGroup.add(mesh)
      const glow = makeGlow(colour, 0.85)
      glow.position.set(f.x, 0.3, f.z)
      findingGroup.add(glow)
      const label = makeLabel(f.detectorId, colour, 0.34)
      label.position.set(f.x, 0.62, f.z)
      findingGroup.add(label)
    }

    // -- the jobs.
    for (const child of [...jobGroup.children]) jobGroup.remove(child)
    for (const j of frame.jobs) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.2, 0.02, 6, 18),
        new THREE.MeshBasicMaterial({ color: COLOURS.job, transparent: true, opacity: 0.55 }),
      )
      ring.rotation.x = Math.PI / 2
      ring.position.set(j.x, 0.05, j.z)
      jobGroup.add(ring)
    }

    // -- the truth overlay, off unless asked for.
    for (const child of [...truthGroup.children]) truthGroup.remove(child)
    for (const t of frame.truth) {
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.18, 0),
        new THREE.MeshBasicMaterial({ color: COLOURS.truth, wireframe: true, transparent: true, opacity: 0.9 }),
      )
      mesh.position.set(t.x, t.y, t.z)
      truthGroup.add(mesh)
    }
  }

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

/** Where a fault is, in world coordinates, for a drop line to the plating below. */
export function platingBelow(form: HullForm, x: number, cutZ: number): THREE.Vector3 {
  return hullSurfaceBelow(form, x, cutZ)
}
