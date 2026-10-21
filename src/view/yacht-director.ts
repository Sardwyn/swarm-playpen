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

export type Shot = {
  /** Shown in the console while the shot is live. */
  readonly name: string
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
}

export type CameraState = {
  readonly targetX: number
  readonly targetY: number
  readonly targetZ: number
  readonly yaw: number
  readonly pitch: number
  readonly distance: number
  readonly fov: number
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
 */
export const CUT: readonly Shot[] = [
  {
    name: 'ESTABLISH',
    from: 0.0,
    to: 0.11,
    target: [0.5, 0.4, 0],
    target2: [-1.5, 0.2, 0],
    yaw: 1.35,
    yaw2: 1.05,
    pitch: 0.3,
    pitch2: 0.24,
    distance: 22,
    distance2: 15,
    fov: 42,
    fov2: 42,
  },
  {
    // Low and behind, so the ground bot is silhouetted against the engine room
    // and its own light spreads out in front of it.
    name: 'GROUND-01 · SWEEP',
    from: 0.11,
    to: 0.34,
    follow: 'ground-01',
    relativeYaw: Math.PI * 0.78,
    pitch: 0.16,
    pitch2: 0.1,
    distance: 4.4,
    distance2: 3.2,
    fov: 52,
    fov2: 48,
  },
  {
    // Above and behind, looking down into the 410 mm deckhead void the hover bot
    // is holding station in.
    name: 'HOVER-01 · DECKHEAD',
    from: 0.34,
    to: 0.5,
    follow: 'hover-01',
    relativeYaw: Math.PI * 0.85,
    pitch: 0.46,
    pitch2: 0.62,
    distance: 3.4,
    distance2: 2.6,
    fov: 55,
    fov2: 55,
  },
  {
    // Right down on the bore. The crawler is 80 mm across and it is in a
    // 60 mm pipe, so this shot is the only way it is ever going to be seen.
    name: 'INCH-01 · FUEL LINE',
    from: 0.5,
    to: 0.63,
    follow: 'inch-01',
    relativeYaw: Math.PI * 0.7,
    pitch: 0.34,
    pitch2: 0.2,
    distance: 1.5,
    distance2: 1.1,
    fov: 62,
    fov2: 62,
  },
  {
    // Pull forward along the hull. The void does not light up.
    name: 'THE VOID',
    from: 0.63,
    to: 0.75,
    target: [0.5, 0.4, 0],
    target2: [3.0, 0.2, 0.65],
    yaw: 1.2,
    yaw2: 1.5,
    pitch: 0.2,
    pitch2: 0.3,
    distance: 12,
    distance2: 7,
    fov: 44,
    fov2: 44,
  },
  {
    // Above the deck, looking down through the 200 mm hole.
    name: '200 mm',
    from: 0.75,
    to: 0.88,
    target: [3.0, 0.9, 0.65],
    target2: [3.0, 0.7, 0.65],
    yaw: 1.3,
    yaw2: 1.55,
    pitch: 0.72,
    pitch2: 0.44,
    distance: 6.5,
    distance2: 4.2,
    fov: 46,
    fov2: 46,
  },
  {
    name: 'RELEASE',
    from: 0.88,
    to: 1.0,
    target: [3.0, 0.7, 0.65],
    target2: [0.4, 0.4, 0],
    yaw: 1.55,
    yaw2: 1.05,
    pitch: 0.44,
    pitch2: 0.3,
    distance: 4.2,
    distance2: 17,
    fov: 46,
    fov2: 42,
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
        ty = agent.y + 0.25
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
    }
  }
}
