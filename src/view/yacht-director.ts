/**
 * The camera director.
 *
 * ## Why a director and not a keyframe list
 *
 * The first version interpolated between seven fixed camera positions over the
 * whole run. It was smooth in the way a lerp is smooth, and it looked like a
 * slide show with a camera on it: the camera never got close to anything, so
 * the robots stayed the size of specks, and the moves were so long that the
 * viewer had time to notice there was nothing happening.
 *
 * A camera is a *point of view on a subject*. The subject here is three
 * machines doing three different jobs in three different places — one on the
 * sole of an engine room, one in a 410 mm void above it, one inside a 60 mm
 * fuel line. A camera that frames all three at once frames none of them.
 *
 * So the cut is a list of **shots**, and a shot either holds a fixed position
 * or **locks onto an agent** and moves with it: the target becomes the robot,
 * the yaw becomes the robot's heading plus an offset, and the distance is the
 * shot's choice. That is how you make a 340 mm machine read on a 17 m boat —
 * not by making the machine bigger, but by putting the camera 4 m away.
 *
 * ## Where the jerk was
 *
 * The camera's input used to be an **integer frame index**, and the frame
 * index is quantised to the recording rate. So the camera was asked for its
 * position twenty times a second and held it for the other forty, and the
 * robot it was following moved in the same twenty steps. Everything juddered
 * together, which is the worst kind of judder: it looks like the whole thing
 * is broken rather than merely choppy.
 *
 * The director now takes a **continuous** time, and the agents' poses are
 * interpolated between recorded frames, so the camera and the subject are
 * smooth in the same way at the same time.
 *
 * ## The second kind of judder
 *
 * Even with the poses interpolated, the camera swung five point nine radians in
 * a single frame, because its yaw was the robot's *heading* and a rover doing a
 * coverage pattern turns hard. So the camera follows the direction of travel
 * over a couple of seconds instead — where the machine is going, rather than
 * which way its wheels are pointing. A camera operator does the same thing.
 */

import type { SimFrame } from '../sim/report/frame.ts'
import { angleDelta, clamp } from '../sim/math.ts'

/**
 * Where the boat is cut open.
 *
 * Everything with a greater z than this is removed: the hull, the deck, the
 * engine room and the machinery inside it. The viewer looks in through the
 * cut, the way an exhibition model is cut, and every shot that films a
 * compartment has to work with the fact that the compartment has no starboard
 * wall and no deckhead over the last third of its width.
 */
export const CUT_Z = 0.65

export type Shot = {
  /** Shown in the console while the shot is live. */
  readonly name: string
  /**
   * The line under the shot name.
   *
   * Written by hand, because it is a piece of direction: it says what the
   * viewer is being shown and why. Everything else on screen is a measurement;
   * this is the sentence that makes the measurement mean something.
   */
  readonly caption: string
  /** From 0 to 1 of the run. */
  readonly from: number
  readonly to: number
  /** Lock onto this agent: the camera moves with it. */
  readonly follow?: string
  /** Where the camera looks, for a fixed shot. */
  readonly target?: readonly [number, number, number]
  readonly target2?: readonly [number, number, number]
  /** Absolute yaw. */
  readonly yaw?: number
  readonly yaw2?: number
  /** Yaw relative to the followed agent's heading. */
  readonly relativeYaw?: number
  readonly pitch?: number
  readonly pitch2?: number
  readonly distance?: number
  readonly distance2?: number
  readonly fov?: number
  readonly fov2?: number
  /**
   * A box the camera may not leave.
   *
   * A compartment has walls, and a shot that locks onto a machine inside one
   * will place the camera outside it unless it is told not to. `null` — the
   * default — means the camera is free, which is right for every exterior shot.
   */
  readonly confine?: Readonly<Box3> | null
  /** The camera will not come closer to the subject than this. */
  readonly minDistance?: number
  /**
   * How far above the machine the camera looks.
   *
   * A rover is a third of a metre tall and a hover is a fifth, and the shot
   * has to frame the machine rather than the space above it. The default is a
   * quarter of a metre, which suits the rover; the hover in a 410 mm void
   * needs less, because there is not much above it to look at.
   */
  readonly focus?: number
}

/** An axis-aligned box in world coordinates. */
export type Box3 = {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}

export type CameraState = {
  readonly targetX: number
  readonly targetY: number
  readonly targetZ: number
  readonly yaw: number
  readonly pitch: number
  readonly distance: number
  readonly fov: number
  /** The box the camera may not leave, if the shot has one. */
  readonly confine: Readonly<Box3> | null
  /** The closest the camera may come to the subject. */
  readonly minDistance: number
}

function smoothstep(t: number): number {
  const f = Math.min(1, Math.max(0, t))
  return f * f * (3 - 2 * f)
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * The cut.
 *
 * Deliberately hand-written rather than generated: a shot list is a piece of
 * direction, and direction does not come out of a formula.
 *
 * ## The confinement
 *
 * Three of these shots film a machine inside a compartment. A compartment has
 * walls and a deckhead, so a camera that is free to back up ends up outside
 * the boat looking at a bulkhead. Each interior shot therefore carries the
 * volume the camera may work in, and the camera slides along that volume's
 * walls instead of leaving the room.
 */
export const CUT: readonly Shot[] = [
  {
    name: 'FLYBY',
    caption: 'SUNSEEKER PREDATOR 55. AUTONOMOUS SWARM INSPECTION IN PROGRESS.',
    from: 0.0,
    to: 0.12,
    target: [0, 2, 0],
    target2: [-8, 3, 4],
    yaw: 1.0,
    yaw2: 0.7,
    pitch: 0.3,
    pitch2: 0.25,
    distance: 28,
    distance2: 22,
    fov: 50,
    fov2: 54,
  },
  {
    name: 'INSIDE THE ENGINE ROOM',
    caption: 'CUTAWAY VIEW - THREE ROBOTS WORKING IN PARALLEL.',
    from: 0.12,
    to: 0.32,
    target: [-5, 0.8, 0],
    target2: [-4, 0.6, 1],
    yaw: 0.6,
    yaw2: 0.4,
    pitch: 0.2,
    pitch2: 0.15,
    distance: 14,
    distance2: 10,
    fov: 58,
    fov2: 62,
  },
  {
    name: 'GROUND-01 · ACTIVE SWEEP',
    caption: 'ROVER MAPPING SOLE - THERMAL, MOISTURE & DEPTH SENSING.',
    from: 0.32,
    to: 0.52,
    follow: 'ground-01',
    relativeYaw: Math.PI * 0.65,
    pitch: 0.18,
    pitch2: 0.12,
    distance: 6.5,
    distance2: 5.0,
    fov: 66,
    fov2: 70,
    focus: 0.15,
    confine: { minX: -8.05, minY: 0.22, minZ: CUT_Z + 0.06, maxX: -2.45, maxY: 0.78, maxZ: 1.55 },
    minDistance: 0.4,
  },
  {
    name: 'HOVER-01 · DECKHEAD SCAN',
    caption: 'DRONE INSPECTING CONFINED VOID - ACCESS IMPOSSIBLE FOR HUMANS.',
    from: 0.52,
    to: 0.68,
    follow: 'hover-01',
    relativeYaw: Math.PI * 0.8,
    pitch: 0.12,
    pitch2: 0.06,
    distance: 3.2,
    distance2: 2.6,
    fov: 70,
    fov2: 74,
    focus: 0.02,
    confine: { minX: -8.05, minY: 1.02, minZ: 0.15, maxX: -2.45, maxY: 1.34, maxZ: 1.6 },
    minDistance: 0.35,
  },
  {
    name: 'INCH-01 · PIPE INSPECTION',
    caption: 'CRAWLER NAVIGATING 60MM FUEL LINE - ULTRA-COMPACT INSPECTION.',
    from: 0.68,
    to: 0.82,
    follow: 'inchworm',
    relativeYaw: Math.PI * 0.4,
    pitch: 0.04,
    pitch2: -0.01,
    distance: 2.0,
    distance2: 1.6,
    fov: 76,
    fov2: 80,
    focus: 0.01,
    confine: { minX: -7.42, minY: 0.125, minZ: -0.045, maxX: -5.72, maxY: 0.225, maxZ: 0.045 },
    minDistance: 0.15,
  },
  {
    name: 'SWARM OVERVIEW',
    caption: 'COMPLETE COVERAGE - EVERY ACCESSIBLE SPACE MAPPED.',
    from: 0.82,
    to: 1.0,
    target: [-4.5, 1.2, 0.2],
    target2: [-6, 0.9, 0.5],
    yaw: 0.8,
    yaw2: 0.6,
    pitch: 0.2,
    pitch2: 0.16,
    distance: 16,
    distance2: 12,
    fov: 60,
    fov2: 64,
  },
]

/**
 * How fast the camera may swing, in radians per unit of the run.
 *
 * The run is about thirty-four seconds of wall clock, so this is roughly a
 * third of a radian a second — a brisk pan and no more.
 *
 * A camera has inertia. Without a limit, the camera's yaw was the robot's
 * heading and it swung nearly six radians in one frame whenever the robot
 * turned hard, which is a whip pan every time a coverage robot changed its mind.
 */
const MAX_YAW_RATE = 10

export class CameraDirector {
  /** The yaw the camera is actually at, which lags the yaw it wants. */
  private yaw = 0
  private yawSet = false
  private lastT = -1

  constructor(private readonly shots: readonly Shot[] = CUT) {}

  /** The shot live at a point in the run. */
  shotAt(t: number): Shot {
    const u = Math.min(1, Math.max(0, t))
    for (const s of this.shots) {
      if (u >= s.from && u < s.to) return s
    }
    return this.shots[this.shots.length - 1]!
  }

  /**
   * The direction a machine is actually travelling, over a window.
   *
   * Not its heading. A heading is instantaneous, and a rover doing a coverage
   * pattern turns hard and often: the camera followed the heading exactly and
   * swung five point nine radians in one frame, which is the judder the whole
   * interpolation was supposed to remove. The direction of *travel* over a
   * couple of seconds is what a camera operator follows, because it is where the
   * machine is going rather than which way its wheels are pointing.
   */
  private travelHeading(
    sample: (t: number) => SimFrame,
    id: string,
    t: number,
  ): number | null {
    const window = 0.008
    const before = sample(Math.max(0, t - window)).agents.find((a) => a.id === id)
    const after = sample(Math.min(1, t + window)).agents.find((a) => a.id === id)
    if (before === undefined || after === undefined) return null
    const dx = after.x - before.x
    const dz = after.z - before.z
    if (Math.hypot(dx, dz) < 0.03) return null
    return Math.atan2(dz, dx)
  }

  /**
   * The camera at a point in the run, given the interpolated frame.
   *
   * The yaw of a followed shot is the robot's heading plus a fixed offset, so
   * the camera keeps the robot in the same place in the frame while the robot
   * turns — which is what a camera operator does and what makes a machine look
   * like it is going somewhere.
   */
  at(t: number, sample: (t: number) => SimFrame): CameraState {
    const frame = sample(t)
    const shot = this.shotAt(t)
    const span = Math.max(1e-6, shot.to - shot.from)
    const local = smoothstep((t - shot.from) / span)

    let tx = 0
    let ty = 0
    let tz = 0
    if (shot.follow !== undefined) {
      const agent = frame.agents.find((a) => a.id === shot.follow)
      if (agent !== undefined) {
        tx = agent.x
        ty = agent.y + (shot.focus ?? 0.25)
        tz = agent.z
      } else {
        tx = shot.target?.[0] ?? 0
        ty = shot.target?.[1] ?? 0
        tz = shot.target?.[2] ?? 0
      }
    } else {
      const a = shot.target ?? [0, 0, 0]
      const b = shot.target2 ?? a
      tx = mix(a[0], b[0], local)
      ty = mix(a[1], b[1], local)
      tz = mix(a[2], b[2], local)
    }

    let wanted: number
    if (shot.relativeYaw !== undefined) {
      const agent = frame.agents.find((a) => a.id === shot.follow)
      const travel = this.travelHeading(sample, shot.follow ?? '', t)
      wanted = (travel ?? agent?.heading ?? 0) + shot.relativeYaw
    } else {
      wanted = mix(shot.yaw ?? 0, shot.yaw2 ?? shot.yaw ?? 0, local)
    }

    // The rate limit, and a cut's worth of freedom: a shot boundary is allowed
    // to swing the camera immediately, because that is what a cut is.
    const dt = this.lastT < 0 ? 0 : Math.abs(t - this.lastT)
    this.lastT = t
    const cut = this.shotAt(Math.max(0, t - 1e-6)).name !== shot.name
    let yaw: number
    if (!this.yawSet || cut) {
      yaw = wanted
      this.yawSet = true
    } else {
      const limit = MAX_YAW_RATE * dt
      yaw = this.yaw + clamp(angleDelta(wanted, this.yaw), -limit, limit)
    }
    this.yaw = yaw

    const pitch = mix(shot.pitch ?? 0.2, shot.pitch2 ?? shot.pitch ?? 0.2, local)
    const distance = mix(shot.distance ?? 12, shot.distance2 ?? shot.distance ?? 12, local)
    const fov = mix(shot.fov ?? 45, shot.fov2 ?? shot.fov ?? 45, local)

    // A slow handheld drift. Small, deterministic, and the reason the camera
    // does not feel bolted to the world.
    const drift = Math.sin(t * 41.3) * 0.006 + Math.sin(t * 17.1) * 0.004

    return {
      targetX: tx,
      targetY: ty,
      targetZ: tz,
      yaw: yaw + drift,
      pitch: Math.max(0.04, pitch + drift * 0.6),
      distance,
      fov,
      confine: shot.confine ?? null,
      minDistance: shot.minDistance ?? 0,
    }
  }
}
