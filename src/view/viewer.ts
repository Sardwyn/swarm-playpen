/**
 * Three.js viewer. Spec §8.3, ADR-001 §2.2.
 *
 * ## The boundary
 *
 * This file imports `three`. Nothing under `src/sim/` may, and there is a failing
 * test that says so. The viewer reads a `SimFrame` and writes nothing: no state
 * change, no cache, no persistence. Its undo is "rebuild the frame".
 *
 * The consequence is a real ergonomic loss — you cannot drag an agent to where you
 * think it should be and watch the allocator cope. That is deliberate. Debugging
 * that bypasses the boundary is debugging that lies to you, and the substitute is
 * the same injected-command path the tests use.
 *
 * ## What it is for
 *
 * Interrogation, not demonstration. Every metric on screen carries the detector ID
 * that produced it, and the truth overlay is off by default and labelled when on,
 * because a viewer that quietly shows you the answer key teaches you nothing about
 * whether the system works.
 */

import * as THREE from 'three'
import type { SimFrame } from '../sim/report/frame.ts'
import { structureIndices } from '../sim/report/frame.ts'

const COLOURS = {
  free: new THREE.Color(0x1b2430),
  unknown: new THREE.Color(0x0d1117),
  wall: new THREE.Color(0x8fa3b8),
  blocked: new THREE.Color(0xc9a227),
  agent: new THREE.Color(0x4fd1c5),
  agentFaulted: new THREE.Color(0xfc8181),
  job: new THREE.Color(0x63b3ed),
  jobActive: new THREE.Color(0x68d391),
  findingConfirmed: new THREE.Color(0xf6e05e),
  findingUnverified: new THREE.Color(0xed8936),
  truth: new THREE.Color(0xb794f4),
}

export type ViewerLayers = {
  grid: boolean
  structure: boolean
  agents: boolean
  jobs: boolean
  findings: boolean
  /** The authored oracle. Debug view. Spec §8.3. */
  truth: boolean
}

export type ViewerOptions = {
  readonly container: HTMLElement
  readonly layers?: Partial<ViewerLayers>
}

export class Viewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly orbit: OrbitShim
  private readonly freeCam: { yaw: number; pitch: number; x: number; y: number; z: number; active: boolean }

  private readonly floorMesh: THREE.Mesh
  private readonly wallPoints: THREE.Points
  private readonly agentGroup = new THREE.Group()
  private readonly jobGroup = new THREE.Group()
  private readonly findingGroup = new THREE.Group()
  private readonly truthGroup = new THREE.Group()

  private frame: SimFrame | null = null
  private selected: string | null = null
  private raf = 0

  layers: ViewerLayers

  constructor(options: ViewerOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setSize(options.container.clientWidth, options.container.clientHeight)
    options.container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0d1117)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const sun = new THREE.DirectionalLight(0xffffff, 0.55)
    sun.position.set(4, 12, 6)
    this.scene.add(sun)

    this.camera = new THREE.PerspectiveCamera(
      55,
      options.container.clientWidth / options.container.clientHeight,
      0.05,
      500,
    )
    this.camera.position.set(-14, 14, -14)
    this.camera.lookAt(0, 0, 0)

    // The orbit shim is inlined below, so the viewer's entire dependency surface is a
    // single import of `three`.
    this.orbit = new OrbitShim(this.camera, this.renderer.domElement)

    this.floorMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    )
    this.floorMesh.rotation.x = -Math.PI / 2
    this.scene.add(this.floorMesh)

    this.wallPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: COLOURS.wall, size: 0.09 }),
    )
    this.scene.add(this.wallPoints)

    this.scene.add(this.agentGroup, this.jobGroup, this.findingGroup, this.truthGroup)

    this.freeCam = { yaw: 0, pitch: -0.6, x: -14, y: 6, z: -14, active: false }

    this.layers = {
      grid: true,
      structure: true,
      agents: true,
      jobs: true,
      findings: true,
      truth: false,
      ...options.layers,
    }

    this.applyLayerVisibility()
    this.bindKeys(options.container)
    window.addEventListener('resize', () => this.resize(options.container))
    this.loop()
  }

  /** Read a new frame. The only way data enters the viewer. */
  setFrame(frame: SimFrame): void {
    this.frame = frame
    this.rebuildFloor()
    this.rebuildStructure()
    this.rebuildAgents()
    this.rebuildJobs()
    this.rebuildFindings()
    this.rebuildTruth()
    this.applyLayerVisibility()
  }

  select(id: string | null): void {
    this.selected = id
  }

  get selectedId(): string | null {
    return this.selected
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  private rebuildFloor(): void {
    const frame = this.frame
    if (frame === null) return

    const positions = new Float32Array(frame.cellState.length * 3)
    const colours = new Float32Array(frame.cellState.length * 3)
    const indices: number[] = []

    for (let i = 0; i < frame.cellState.length; i++) {
      const cx = i % frame.gridWidth
      const cz = (i - cx) / frame.gridWidth
      const x = frame.bounds.minX + (cx + 0.5) * frame.cellSize
      const z = frame.bounds.minZ + (cz + 0.5) * frame.cellSize

      positions[i * 3] = x
      positions[i * 3 + 1] = 0
      positions[i * 3 + 2] = z

      const state = frame.cellState[i]!
      const seen = frame.observed[i]! > 0
      const colour =
        state === 2 || state === 3
          ? COLOURS.wall
          : seen
            ? COLOURS.free
            : COLOURS.unknown
      colours[i * 3] = colour.r
      colours[i * 3 + 1] = colour.g
      colours[i * 3 + 2] = colour.b

      if (cx + 1 < frame.gridWidth && frame.cellState[i + 1] !== 2) indices.push(i, i + 1)
      if (cz + 1 < frame.gridHeight && frame.cellState[i + frame.gridWidth] !== 2) {
        indices.push(i, i + frame.gridWidth)
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3))
    geometry.setIndex(indices)
    this.floorMesh.geometry.dispose()
    this.floorMesh.geometry = geometry
  }

  private rebuildStructure(): void {
    const frame = this.frame
    if (frame === null) return
    const idx = structureIndices(frame)
    const positions = new Float32Array(idx.length * 3)
    for (let n = 0; n < idx.length; n++) {
      const i = idx[n]!
      const cx = i % frame.gridWidth
      const cz = (i - cx) / frame.gridWidth
      positions[n * 3] = frame.bounds.minX + (cx + 0.5) * frame.cellSize
      positions[n * 3 + 1] = 0.22
      positions[n * 3 + 2] = frame.bounds.minZ + (cz + 0.5) * frame.cellSize
    }
    this.wallPoints.geometry.dispose()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.wallPoints.geometry = geometry
  }

  private rebuildAgents(): void {
    const frame = this.frame
    if (frame === null) return
    this.clear(this.agentGroup)

    for (const a of frame.agents) {
      const geometry = new THREE.ConeGeometry(0.22, 0.4, 4)
      const material = new THREE.MeshBasicMaterial({
        color: a.faulted ? COLOURS.agentFaulted : COLOURS.agent,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(a.x, 0.3, a.z)
      // Cone points +y by default; rotate so it points along the heading.
      mesh.rotation.set(Math.PI / 2, 0, -a.heading)
      mesh.userData.pick = a.id
      this.agentGroup.add(mesh)

      // A battery bar, so endurance is legible without reading the panel.
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.5, 0.06),
        new THREE.MeshBasicMaterial({ color: a.battery > 0.3 ? COLOURS.agent : COLOURS.findingUnverified }),
      )
      bar.position.set(a.x, 0.75, a.z)
      bar.scale.y = Math.max(0.05, a.battery)
      this.agentGroup.add(bar)
    }
  }

  private rebuildJobs(): void {
    const frame = this.frame
    if (frame === null) return
    this.clear(this.jobGroup)

    for (const j of frame.jobs) {
      if (j.state === 'done' || j.state === 'failed') continue
      const active = j.state === 'active'
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.06, 0.45),
        new THREE.MeshBasicMaterial({
          color: active ? COLOURS.jobActive : COLOURS.job,
          transparent: true,
          opacity: active ? 0.85 : 0.35,
        }),
      )
      mesh.position.set(j.x, 0.05, j.z)
      mesh.userData.pick = j.id
      this.jobGroup.add(mesh)
    }
  }

  private rebuildFindings(): void {
    const frame = this.frame
    if (frame === null) return
    this.clear(this.findingGroup)

    for (const f of frame.findings) {
      const confirmed = f.status === 'confirmed'
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.16 + f.confidence * 0.2),
        new THREE.MeshBasicMaterial({
          color: confirmed ? COLOURS.findingConfirmed : COLOURS.findingUnverified,
        }),
      )
      mesh.position.set(f.x, 0.9, f.z)
      mesh.userData.pick = f.id
      mesh.userData.selected = f.id === this.selected
      if (f.id === this.selected) {
        mesh.scale.setScalar(1.7)
      }
      this.findingGroup.add(mesh)
    }
  }

  private rebuildTruth(): void {
    const frame = this.frame
    if (frame === null) return
    this.clear(this.truthGroup)

    for (const t of frame.truth) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.2),
        new THREE.MeshBasicMaterial({ color: COLOURS.truth, wireframe: true }),
      )
      mesh.position.set(t.x, t.y + 0.3, t.z)
      this.truthGroup.add(mesh)
    }
  }

  private clear(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child)
      const mesh = child as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | undefined
      material?.dispose()
    }
  }

  private applyLayerVisibility(): void {
    this.floorMesh.visible = this.layers.grid
    this.wallPoints.visible = this.layers.structure
    this.agentGroup.visible = this.layers.agents
    this.jobGroup.visible = this.layers.jobs
    this.findingGroup.visible = this.layers.findings
    this.truthGroup.visible = this.layers.truth
  }

  // -------------------------------------------------------------------------
  // Cameras and input
  // -------------------------------------------------------------------------

  private bindKeys(container: HTMLElement): void {
    const keys = new Set<string>()
    container.tabIndex = 0

    container.addEventListener('keydown', (e) => {
      keys.add(e.key.toLowerCase())
      if (e.key === 'Tab') {
        e.preventDefault()
        this.freeCam.active = !this.freeCam.active
        this.orbit.enabled = !this.freeCam.active
        if (this.freeCam.active) {
          this.freeCam.x = this.camera.position.x
          this.freeCam.y = this.camera.position.y
          this.freeCam.z = this.camera.position.z
        }
      }
    })
    container.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
    container.addEventListener('blur', () => keys.clear())

    this.keys = keys
  }

  private keys = new Set<string>()

  private updateCamera(): void {
    if (!this.freeCam.active) {
      this.orbit.update()
      return
    }
    const speed = 0.35
    const forward = new THREE.Vector3(
      Math.cos(this.freeCam.yaw) * Math.cos(this.freeCam.pitch),
      Math.sin(this.freeCam.pitch),
      Math.sin(this.freeCam.yaw) * Math.cos(this.freeCam.pitch),
    )
    const right = new THREE.Vector3(Math.sin(this.freeCam.yaw), 0, -Math.cos(this.freeCam.yaw))

    if (this.keys.has('w')) this.freeCam.x += forward.x * speed
    if (this.keys.has('w')) this.freeCam.y += forward.y * speed
    if (this.keys.has('w')) this.freeCam.z += forward.z * speed
    if (this.keys.has('s')) this.freeCam.x -= forward.x * speed
    if (this.keys.has('s')) this.freeCam.y -= forward.y * speed
    if (this.keys.has('s')) this.freeCam.z -= forward.z * speed
    if (this.keys.has('a')) this.freeCam.x -= right.x * speed
    if (this.keys.has('a')) this.freeCam.z -= right.z * speed
    if (this.keys.has('d')) this.freeCam.x += right.x * speed
    if (this.keys.has('d')) this.freeCam.z += right.z * speed
    if (this.keys.has('e')) this.freeCam.y += speed
    if (this.keys.has('q')) this.freeCam.y -= speed

    if (this.keys.has('arrowleft')) this.freeCam.yaw -= 0.06
    if (this.keys.has('arrowright')) this.freeCam.yaw += 0.06
    if (this.keys.has('arrowup')) this.freeCam.pitch += 0.05
    if (this.keys.has('arrowdown')) this.freeCam.pitch -= 0.05
    this.freeCam.pitch = Math.max(-1.5, Math.min(1.5, this.freeCam.pitch))

    this.camera.position.set(this.freeCam.x, this.freeCam.y, this.freeCam.z)
    this.camera.lookAt(
      this.freeCam.x + Math.cos(this.freeCam.yaw) * Math.cos(this.freeCam.pitch),
      this.freeCam.y + Math.sin(this.freeCam.pitch),
      this.freeCam.z + Math.sin(this.freeCam.yaw) * Math.cos(this.freeCam.pitch),
    )
  }

  /** Ray-pick a finding or agent marker. Read-only: selection is viewer state. */
  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    for (const group of [this.findingGroup, this.agentGroup, this.jobGroup]) {
      const hits = ray.intersectObjects(group.children, false)
      if (hits.length > 0) {
        const id = hits[0]!.object.userData.pick as string | undefined
        if (id !== undefined) return id
      }
    }
    return null
  }

  focusOn(x: number, z: number): void {
    this.orbit.target.set(x, 0.3, z)
    this.freeCam.x = x
    this.freeCam.z = z
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop)
    this.updateCamera()
    this.renderer.render(this.scene, this.camera)
  }
}

/**
 * Minimal orbit controls, inlined.
 *
 * `three/examples/jsm/controls/OrbitControls` would do this, but keeping a hundred
 * lines here means the viewer's entire dependency surface is one import of
 * `three`, and the boundary test only has to reason about `three` itself.
 */
/**
 * A minimal orbit control, inlined so the viewer's entire dependency surface is a
 * single import of `three`.
 *
 * Exported because the yacht scene needs the same behaviour and there should be
 * one implementation of it. The fields are public so a scene can set an opening
 * framing — a building and a boat want different ones.
 */
export class OrbitShim {
  enabled = true
  readonly target = new THREE.Vector3()

  yaw = -Math.PI / 4
  pitch = 0.9
  distance = 22

  private dragging = false
  private lastX = 0
  private lastY = 0

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    element: HTMLElement,
  ) {
    element.addEventListener('pointerdown', (e) => {
      this.dragging = true
      this.lastX = e.clientX
      this.lastY = e.clientY
    })
    element.addEventListener('pointerup', () => {
      this.dragging = false
    })
    element.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.enabled) return
      this.yaw -= (e.clientX - this.lastX) * 0.005
      this.pitch = Math.max(0.05, Math.min(1.5, this.pitch - (e.clientY - this.lastY) * 0.005))
      this.lastX = e.clientX
      this.lastY = e.clientY
    })
    element.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return
        this.distance = Math.max(3, Math.min(80, this.distance + e.deltaY * 0.02))
        e.preventDefault()
      },
      { passive: false },
    )
  }

  update(): void {
    if (!this.enabled) return
    const x = this.target.x + Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance
    const y = this.target.y + Math.sin(this.pitch) * this.distance
    const z = this.target.z + Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance
    this.camera.position.set(x, y, z)
    this.camera.lookAt(this.target)
  }
}