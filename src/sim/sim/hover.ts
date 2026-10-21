/**
 * The hover bot: kinematics, clearance cost, and power. Spec §3.3 and §11.29, Stage F.
 *
 * ## What is modelled and what is not
 *
 * Spec §3.3 gives "full 6-DoF attitude, ±0.4 m/s, ±40 °/s". What is implemented is
 * **position and yaw as controlled degrees of freedom, plus a tracked tilt magnitude** that
 * the power model reads. That reduction is recorded as a cut rather than hidden, and it is
 * made deliberately:
 *
 * - Tilt is not decoration. Holding station under a low ceiling means fighting induced
 *   downwash, and that cost is the decision-relevant consequence of the clearance
 *   constraint — it is what makes flying into the attic *expensive* rather than
 *   impossible, which is precisely what spec open question 1 asks.
 * - What is **not** modelled is attitude control as a dynamics problem: no rotor mixing,
 *   no aerodynamic cross-coupling, no thrust-vector lag. A flight simulator would make the
 *   clearance cost emerge from the physics; here it is a stated function of the geometry,
 *   which is more honest than a crude integration pretending otherwise.
 *
 * ## The clearance model, and why it is a blockage ratio against the space *above*
 *
 * The naive model is a linear ramp: "below 1.0 m of headroom, charge proportionally". The
 * one here is grounded in the mechanism instead.
 *
 * A rotor pushes air down. Under a ceiling that air has nowhere to go, so it goes sideways,
 * and the rotor works harder to hold station against the flow it just created. The blockage
 * relation is `thrust ∝ 1 / (1 - span / H)`, where `span` is the rotor diameter and `H` the
 * clearance. Two things fall out of using it:
 *
 * - It is **bounded where it matters and unbounded where it is true**. As `H` approaches
 *   `span` it diverges, and that is physically correct: a rotorcraft cannot hover in a
 *   space its rotors do not fit.
 * - It needs no tuning constant, because the physics supplies the shape.
 *   `HOVER_CLEARANCE_COST` exists as a dial at 1.0 — the pure blockage model — so an
 *   experiment can scale it without re-deriving the curve.
 *
 * ## `H` is the gap above the bot, not the height of the room
 *
 * The first version divided by the height of the whole free run, which charged the same
 * penalty to a bot hovering at 0.3 m and one at 2.2 m in the same 2.50 m room — measured at
 * a 9.6% penalty in *every* position, which is not what a ceiling constraint is.
 *
 * What matters is the distance to the surface **above** the bot, because that is where the
 * downwash has to go. So:
 *
 * - at 0.3 m in a 2.50 m room, gap above 2.20 m, blockage 0.109, multiplier 1.12;
 * - at 2.00 m, gap above 0.50 m, blockage 0.480, multiplier 1.92;
 * - in the attic at 2.90 m with the ceiling at 3.50, gap 0.60 m, blockage 0.400,
 *   multiplier 1.67.
 *
 * This makes the penalty something the bot can *avoid* by flying lower, which is what
 * turns it into a decision rather than a location-dependent tax. It also answers spec open
 * question 1 with a direction: in a 0.90 m attic, flying low is not enough — the space
 * above is at most 0.90 m wherever the bot sits — so the penalty is unavoidable there, and
 * the honest reading is *expensive*, not impossible.
 *
 * ## What is ignored, stated rather than buried
 *
 * **Ground effect is not modelled.** A rotor close to a floor gets a cushioning effect that
 * *reduces* required thrust, so ignoring it under-charges a bot flying at low altitude. It is
 * left out because it pushes the opposite way to the constraint under test, and a model
 * that made low flight cheap as well as safe would understate the case for the clearance
 * penalty. Recorded as a cut, not overlooked.
 *
 * ## The number that decides whether any of this matters: 98 W on a 22 Wh pack
 *
 * 86 W hover + 12 W sensors is 98 W, so an uninterrupted mission burns
 * `22 Wh / 98 W = 13.5 min = 808 s`. The reference mission is **300 s**. At that length the
 * hover bot uses about 37% of its pack and **cannot run out** — so the stage F gate "hover
 * endurance respected by allocation" is **not evaluable at 300 s**, for the same reason
 * energy was not evaluable in S9 (§11.27). This module exists so the measurement is
 * *possible*; `hover-endurance` reports the mission length at which it does bind.
 */

import type { AgentState, Pose3 } from '../types.ts'
import { HOVER, HOVER_CLEARANCE_COST, HOVER_TILT_COST } from '../types.ts'
import { clamp, atan2, wrapPi, hypot3 } from '../math.ts'
import { VOXEL, runAt, type VoxelGrid } from '../world/volumetric.ts'

/** First-order lag on tilt, fixed coefficient, no clock reads. */
const TILT_RESPONSE = 0.25

/** Spec §3.3: 40 deg/s, converted once. */
export const MAX_YAW_RATE = (40 * Math.PI) / 180

/**
 * Vertical gap between the bot and the first surface above it, in metres.
 *
 * Returns `spanM` as a floor when there is no gap, so the blockage ratio saturates at 1
 * rather than dividing by zero. Returns 0 when the bot is not in air at all, which the
 * caller should never be.
 */
export function clearanceAbove(grid: VoxelGrid, x: number, y: number, z: number, spanM: number = HOVER.height): number {
  const run = runAt(grid, x, y, z)
  if (run === null) return 0
  // `run.y1` is the top of the topmost free voxel, which is the underside of whatever is
  // above. The bot's own voxel centre is below it, so this is a real clearance, not a
  // half-voxel fudge.
  const gap = run.y1 - y
  return gap < spanM ? spanM : gap
}

/**
 * Rotor span as a fraction of the clearance above the bot. This is the blockage ratio.
 *
 * 0 in open air, approaching 1 as the ceiling closes onto the rotor diameter.
 */
export function clearanceBlockage(
  grid: VoxelGrid,
  x: number,
  y: number,
  z: number,
  spanM: number = HOVER.height,
): number {
  const gap = clearanceAbove(grid, x, y, z, spanM)
  if (gap <= 0) return 0.99
  return clamp(spanM / gap, 0, 0.99)
}

/** Thrust multiplier from low clearance. 1.0 in open air. */
export function clearanceMultiplier(
  grid: VoxelGrid,
  x: number,
  y: number,
  z: number,
  spanM: number = HOVER.height,
): number {
  const b = clearanceBlockage(grid, x, y, z, spanM)
  return 1 + HOVER_CLEARANCE_COST * (1 / (1 - b) - 1)
}

/**
 * Watts for one tick, itemised so the 86 W draw stays legible in a report.
 *
 * Three terms, and the split is the point:
 *
 * - **hover** — the floor. A thrust-vectored quadrotor burns power to stay up at all, so
 *   this is never zero and does not scale with distance the way a ground bot's draw does.
 * - **tilt** — the cost of accelerating laterally, and of fighting induced flow in a tight
 *   space. Proportional to tracked tilt magnitude, not to commanded speed.
 * - **sensors** — flat, per spec §3.3.
 *
 * The blockage term applies whether or not the bot is travelling: holding station still in
 * a tight space is not free, because the downwash does not stop being fought just because
 * the bot stopped moving.
 */
export function hoverPower(
  grid: VoxelGrid,
  pose: Pose3,
  tilt: number,
  moving: boolean,
): { hover: number; tilt: number; sensors: number; total: number; blockage: number } {
  const blockage = clearanceBlockage(grid, pose.x, pose.y, pose.z)
  const base = HOVER.powerCruise * (1 + HOVER_CLEARANCE_COST * (1 / (1 - blockage) - 1))
  const commanded = moving ? clamp(tilt, 0, 1) : 0
  const tiltW = HOVER.powerCruise * HOVER_TILT_COST * (commanded + blockage * HOVER_CLEARANCE_COST)
  const sensors = HOVER.powerSensors
  return { hover: base, tilt: tiltW, sensors, total: base + tiltW + sensors, blockage }
}

/** Wh consumed in one tick at a given draw. Spec §9.5: TICK_HZ fixed, no clock reads. */
export function whForTick(watts: number, tickSeconds: number): number {
  return (watts * tickSeconds) / 3600
}

/** Is this world point flyable, body included? Mirrors the ground bot's `isPassable`. */
export function hoverPassable(
  grid: VoxelGrid,
  mask: Uint8Array,
  x: number,
  y: number,
  z: number,
): boolean {
  const ix = Math.floor((x - grid.minX) / VOXEL)
  const iy = Math.floor((y - grid.minY) / VOXEL)
  const iz = Math.floor((z - grid.minZ) / VOXEL)
  if (ix < 0 || ix >= grid.nx || iy < 0 || iy >= grid.ny || iz < 0 || iz >= grid.nz) return false
  return mask[ix + grid.nx * (iy + grid.ny * iz)] === 1
}

export type HoverStep = {
  /** A new agent state. Pure: the input state is not mutated. */
  readonly state: AgentState
  readonly moved: boolean
  readonly tilt: number
  readonly pathLength: number
  readonly exhausted: boolean
}

/**
 * Advance the hover bot one tick along its 3-D plan.
 *
 * ## Motion is translation, not rotation-and-translate
 *
 * The bot moves straight at `cruiseSpeed` toward the current waypoint and turns its yaw
 * toward the direction of travel at `MAX_YAW_RATE`. It does not have to *arrive* pointing
 * the right way before moving, and that is the physical difference from a ground bot: a
 * differential-drive chassis must turn before it can drive, a rotorcraft does not. The yaw
 * rate is kept because the viewer draws the heading and because a directional sensor model
 * would otherwise have nothing to read.
 *
 * ## No tunnelling
 *
 * A tick moves at most `cruiseSpeed * dt`. At 0.4 m/s and 10 Hz that is 0.04 m, well under
 * the 0.10 m voxel, so one step cannot cross a voxel. The destination is tested against the
 * passability mask anyway, because the cheap test is the one that fails silently.
 *
 * ## Pure, like the ground bot
 *
 * Returns a new `AgentState` rather than mutating. This matches `stepGround`, which returns
 * `{ state: { ...state, pose } }`, and it is why `AgentState.pose` and the `Pose3` fields
 * can stay `readonly` without the run loop needing a cast to move the bot.
 */
export function stepHover(
  grid: VoxelGrid,
  mask: Uint8Array,
  state: AgentState,
  dtSeconds: number,
): HoverStep {
  const pose = state.pose as Pose3

  const idle = (extra: Partial<AgentState> = {}, exhausted = false): HoverStep => ({
    state: { ...state, ...extra },
    moved: false,
    tilt: state.tilt,
    pathLength: 0,
    exhausted,
  })

  if (state.plan3Index >= state.plan3.length) return idle({}, true)

  const target = state.plan3[state.plan3Index]!
  const dx = target.x - pose.x
  const dy = target.y - pose.y
  const dz = target.z - pose.z
  const dist = hypot3(dx, dy, dz)

  // A waypoint we are already standing on is consumed without moving. Counting it as a move
  // would reset the stall counter for a bot that is genuinely stuck against it.
  if (dist < 1e-6) {
    const next = state.plan3Index + 1
    return idle({ plan3Index: next }, next >= state.plan3.length)
  }

  const step = Math.min(HOVER.cruiseSpeed * dtSeconds, dist)
  const inv = 1 / dist
  const nx = pose.x + dx * inv * step
  const ny = pose.y + dy * inv * step
  const nz = pose.z + dz * inv * step

  // Yaw toward travel. Heading is 0 along +x and grows toward +z, matching the ground
  // manifold's convention so one viewer transform serves both.
  const wantYaw = wrapPi(atan2(dz, dx))
  const turn = clamp(wantYaw - pose.yaw, -MAX_YAW_RATE * dtSeconds, MAX_YAW_RATE * dtSeconds)

  if (!hoverPassable(grid, mask, nx, ny, nz)) return idle()

  const speedFraction = clamp(step / (HOVER.cruiseSpeed * dtSeconds), 0, 1)
  const tilted = state.tilt + (speedFraction - state.tilt) * TILT_RESPONSE
  // Roll and pitch are derived from the heading error, not integrated: the attitude is a
  // readout of how hard the controller is working, which is all the power model reads.
  const lateral = clamp(wrapPi(wantYaw - pose.yaw) * 0.5, -0.5, 0.5)
  const next = state.plan3Index + (step >= dist - 1e-9 ? 1 : 0)

  return {
    state: {
      ...state,
      plan3Index: next,
      tilt: tilted,
      pose: {
        x: nx,
        y: ny,
        z: nz,
        yaw: wrapPi(pose.yaw + turn),
        roll: -lateral,
        pitch: clamp(tilted, 0, 1) * 0.35,
      },
    },
    moved: true,
    tilt: tilted,
    pathLength: step,
    exhausted: next >= state.plan3.length,
  }
}

/**
 * Seconds of flight left on a full pack, at a given draw.
 *
 * Exists because the stage F gate asks about endurance and the answer is a function of
 * mission length: at 98 W the hover bot flies for 808 s, at 133 W under the attic ceiling
 * for 595 s. The reference mission is 300 s. Reporting endurance as a duration rather than
 * a percentage is what makes that comparison possible at all.
 */
export function enduranceSeconds(watts: number, batteryWh: number): number {
  if (watts <= 0) return Number.POSITIVE_INFINITY
  return (batteryWh / watts) * 3600
}