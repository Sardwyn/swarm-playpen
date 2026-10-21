/**
 * Hull geometry for the yacht domain.
 *
 * ## Why this is in the view and not in the sim
 *
 * ADR-001 §2: nothing under `src/sim/` may import `three`, and a failing test
 * says so. The simulation needs to know where the hull's surfaces *are*; it does
 * not need to know how they are drawn. So the form is computed in
 * `sim/world/yacht-form.ts` and the mesh is built here, from the same numbers.
 *
 * ## What is drawn
 *
 * Three things, in the order they matter:
 *
 * 1. **The hull surface**, as a shell. It is drawn translucent because the point of
 *    the picture is what is *inside* the boat, and a solid hull hides that.
 * 2. **The profile ribbon** — the strip of plating between the baseline and the
 *    hull's inner surface at the cut plane. This is the inboard profile, the
 *    drawing a naval architect reads, laid over the three-dimensional boat.
 * 3. **The profile curve** — where the cut plane meets the hull, drawn bright.
 *
 * The cut plane is offset from the centreline because the stringer voids sit
 * *between* stringers. A centreline cut misses every void, and the voids are the
 * subject.
 */

import * as THREE from 'three'
import type { HullForm } from '../sim/world/yacht-form.ts'
import {
  cutPlaneLeavesHullAt,
  hullBottomYSim,
  stationAt,
  uFromX,
} from '../sim/world/yacht-form.ts'

export type HullGeometry = {
  /** The outer shell of the hull, both sides. */
  readonly shell: THREE.BufferGeometry
  /** The strip of plating below the cut plane, from the baseline up to the hull. */
  readonly profileRibbon: THREE.BufferGeometry
  /** The line where the cut plane meets the hull's inner surface. */
  readonly profileCurve: THREE.BufferGeometry
  /** The deck edge, port and starboard, as a closed line. */
  readonly sheerLine: THREE.BufferGeometry
}

/**
 * The section polyline at one station: keel, chine, sheer, on the starboard side.
 *
 * Three points and two straight runs, because that is what the section of a
 * planing hull is: a straight deadrise panel from the keel to the chine, and a
 * topside from the chine to the sheer. The chine is kept as a distinct vertex
 * because it is where the deadrise ends, and smoothing across it would make the
 * boat look like a barge.
 */
function sectionPoints(form: HullForm, u: number, out: THREE.Vector3[], sign: number): void {
  const s = stationAt(form, u)
  const tan = Math.tan((s.deadriseDeg * Math.PI) / 180)
  // Keel to chine, sampled so the panel has vertices to shade against.
  const DEADRISE_STEPS = 3
  for (let i = 0; i <= DEADRISE_STEPS; i++) {
    const z = (s.chineZ * i) / DEADRISE_STEPS
    out.push(new THREE.Vector3(s.x, s.keelY + z * tan - form.baselineOffsetM, sign * z))
  }
  // Chine to sheer. The topside flares outboard, so the inner surface at a given
  // height is narrower than the sheer, and a straight run is the honest shape for
  // it on this class.
  const TOPSIDE_STEPS = 5
  for (let i = 1; i <= TOPSIDE_STEPS; i++) {
    const t = i / TOPSIDE_STEPS
    const z = s.chineZ + t * (s.sheerZ - s.chineZ)
    out.push(
      new THREE.Vector3(s.x, s.chineY + t * (s.sheerY - s.chineY) - form.baselineOffsetM, sign * z),
    )
  }
}

/**
 * The hull shell.
 *
 * Built as a grid over (station, section point) and mirrored for the port side.
 * The sheer line is shared between the two halves so there is no seam.
 */
export function buildHullShell(form: HullForm, stationCount = 56): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  const starboard: THREE.Vector3[][] = []
  const port: THREE.Vector3[][] = []

  for (let i = 0; i < stationCount; i++) {
    const u = i / (stationCount - 1)
    const sb: THREE.Vector3[] = []
    const pt: THREE.Vector3[] = []
    sectionPoints(form, u, sb, 1)
    sectionPoints(form, u, pt, -1)
    starboard.push(sb)
    port.push(pt)
  }

  const push = (v: THREE.Vector3): number => {
    positions.push(v.x, v.y, v.z)
    return positions.length / 3 - 1
  }

  const sbIndex: number[][] = starboard.map((row) => row.map(push))
  const ptIndex: number[][] = port.map((row) => row.map(push))

  for (let i = 0; i < stationCount - 1; i++) {
    for (let j = 0; j < sbIndex[i]!.length - 1; j++) {
      const a = sbIndex[i]![j]!
      const b = sbIndex[i]![j + 1]!
      const c = sbIndex[i + 1]![j]!
      const d = sbIndex[i + 1]![j + 1]!
      indices.push(a, c, b, b, c, d)
    }
    for (let j = 0; j < ptIndex[i]!.length - 1; j++) {
      const a = ptIndex[i]![j]!
      const b = ptIndex[i]![j + 1]!
      const c = ptIndex[i + 1]![j]!
      const d = ptIndex[i + 1]![j + 1]!
      indices.push(a, b, c, b, d, c)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The plating at the cut plane.
 *
 * A strip of hull structure following the hull's inner surface, not a fill down to
 * the baseline. The space under the hull is sea, not plating, and drawing it as
 * structure turned the boat into a grey sail — the first version filled from
 * y = 0, which on a deep-V hull is most of the frame.
 *
 * The profile is **truncated** where the cut plane leaves the hull, because past
 * that point the plane is in open water and there is no plating to draw.
 */
export function buildProfileRibbon(
  form: HullForm,
  cutZ: number,
  stationCount = 56,
  plating = 0.09,
): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  const limit = cutPlaneLeavesHullAt(form, cutZ)
  for (let i = 0; i < stationCount; i++) {
    const u = i / (stationCount - 1)
    const s = stationAt(form, u)
    if (s.x > limit) break
    const bottom = hullBottomYSim(form, u, cutZ)
    positions.push(s.x, bottom - plating, cutZ)
    positions.push(s.x, bottom, cutZ)
  }
  const rows = positions.length / 6
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 2
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** The line where the cut plane meets the hull's inner surface. */
export function buildProfileCurve(form: HullForm, cutZ: number, stationCount = 56): THREE.BufferGeometry {
  const positions: number[] = []
  const limit = cutPlaneLeavesHullAt(form, cutZ)
  for (let i = 0; i < stationCount; i++) {
    const u = i / (stationCount - 1)
    const s = stationAt(form, u)
    if (s.x > limit) break
    positions.push(s.x, hullBottomYSim(form, u, cutZ), cutZ)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

/** The deck edge, port and starboard, as one closed line. */
export function buildSheerLine(form: HullForm, stationCount = 56): THREE.BufferGeometry {
  const positions: number[] = []
  for (let i = 0; i < stationCount; i++) {
    const u = i / (stationCount - 1)
    const s = stationAt(form, u)
    positions.push(s.x, s.sheerY - form.baselineOffsetM, s.sheerZ)
  }
  for (let i = stationCount - 1; i >= 0; i--) {
    const u = i / (stationCount - 1)
    const s = stationAt(form, u)
    positions.push(s.x, s.sheerY - form.baselineOffsetM, -s.sheerZ)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

export function buildHullGeometry(form: HullForm, cutZ: number): HullGeometry {
  return {
    shell: buildHullShell(form),
    profileRibbon: buildProfileRibbon(form, cutZ),
    profileCurve: buildProfileCurve(form, cutZ),
    sheerLine: buildSheerLine(form),
  }
}

/**
 * Where the hull's inner surface sits under a longitudinal position.
 *
 * Used to drop a line from a fault in a void down to the plating below it, which
 * is the whole argument for measuring the void rather than the hull: the hull
 * reading is downstream of the void by weeks to months.
 */
export function hullSurfaceBelow(form: HullForm, x: number, cutZ: number): THREE.Vector3 {
  const u = uFromX(form, x)
  return new THREE.Vector3(x, hullBottomYSim(form, u, cutZ), cutZ)
}
