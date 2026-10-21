/**
 * Transcendental functions, reimplemented.
 *
 * WHY THIS FILE EXISTS — ADR-001 §2.3:
 *
 * IEEE-754 specifies `+ - * /` and `sqrt` exactly, so every conforming engine
 * returns bit-identical results. ECMAScript specifies `Math.sin`, `Math.cos`,
 * `Math.exp`, `Math.log` and `Math.pow` only as *approximately* correct — the
 * last bits are implementation-defined, and V8, SpiderMonkey and JavaScriptCore
 * may each differ.
 *
 * A single `Math.sin` in a heading update therefore produces a run that is
 * bit-identical on your machine forever (all local tests pass) and divergent on
 * anyone else's, with the error compounding through the pose graph. That is the
 * worst available failure mode: invisible locally, uninterpretable globally.
 *
 * So the sim core uses only `+ - * /` and `Math.sqrt` from the platform, and
 * everything else comes from here, with FIXED iteration counts — never
 * tolerance-driven, because "iterate until convergence" makes the iteration
 * count a function of the data, which reintroduces the same problem in
 * arithmetic rather than in transcendentals.
 *
 * Accuracy is checked against the built-ins by `test/math/approximations.test.ts`.
 * The built-ins must not be used in `sim/`; `test/determinism/transcendental.test.ts`
 * fails the build if they are.
 */

// ---------------------------------------------------------------------------
// Exactly-specified primitives. Safe to delegate.
// ---------------------------------------------------------------------------

export const sqrt = Math.sqrt

export function abs(x: number): number {
  return x < 0 ? -x : x
}

export function sign(x: number): number {
  if (x > 0) return 1
  if (x < 0) return -1
  return 0
}

export function min(a: number, b: number): number {
  return a < b ? a : b
}

export function max(a: number, b: number): number {
  return a > b ? a : b
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

export function floor(x: number): number {
  return Math.floor(x)
}

/** Truncate toward zero. Math.trunc is exactly specified; delegating is safe. */
export const trunc = Math.trunc

/** Round half away from zero. Explicit because `Math.round` rounds half to even. */
export function round(x: number): number {
  return x >= 0 ? floor(x + 0.5) : -floor(-x + 0.5)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ---------------------------------------------------------------------------
// Angle helpers
// ---------------------------------------------------------------------------

export const PI = 3.141592653589793
export const TWO_PI = 6.283185307179586
const HALF_PI = 1.5707963267948966

/** Wrap to (-PI, PI]. */
export function wrapPi(a: number): number {
  // Round rather than truncate: for an input just under a full turn, truncation
  // yields k = 0 and the angle is returned unwrapped, which silently breaks
  // every angle comparison that assumed a bounded range.
  let x = a - round(a / TWO_PI) * TWO_PI
  if (x > PI) x -= TWO_PI
  if (x <= -PI) x += TWO_PI
  return x
}

/** Shortest signed angular difference a - b, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  return wrapPi(a - b)
}

/**
 * sin(x) for x in [-PI/2, PI/2], Taylor series through x^13/13!.
 *
 * Max term error ~ (PI/2)^13 / 13! = 3.6e-8. Seven terms, fixed count.
 *
 * The recurrence must ALTERNATE sign: t_{n+2} = -t_n * x^2 / ((k+1)(k+2)).
 * Multiplying a term by x^2 alone keeps its sign, which silently turns
 * +x^5/120 into -x^5/120 and makes the series converge to roughly sin(1) for
 * every input — a bug that looks like a range problem rather than a sign one.
 */
function sinHalfPiSeries(x: number): number {
  const x2 = x * x
  let t = x
  let sum = t
  // Denominators (k+1)(k+2) for the successive steps.
  const steps = [6, 20, 42, 72, 110, 156]
  for (let i = 0; i < steps.length; i++) {
    t = (-t * x2) / steps[i]!
    sum += t
  }
  return sum
}

/** sin, range-reduced into [-PI/2, PI/2] then reflected. */
export function sin(x: number): number {
  // Reduce to [-PI, PI]. Rounding (not truncation) matters: trunc would leave
  // 6.28 unwrapped, and the interval test below would then feed 6.28 straight
  // into a series that is only valid near zero — where it diverges to 1e-5
  // instead of failing loudly.
  let r = x - round(x / TWO_PI) * TWO_PI
  if (r > HALF_PI) r = PI - r
  else if (r < -HALF_PI) r = -PI - r
  return sinHalfPiSeries(r)
}

export function cos(x: number): number {
  return sin(x + HALF_PI)
}

export function tan(x: number): number {
  return sin(x) / cos(x)
}

/** radians -> degrees. */
export function toDegrees(a: number): number {
  return (a * 180) / PI
}

/** degrees -> radians. */
export function toRadians(d: number): number {
  return (d * PI) / 180
}

/**
 * atan(x) for x >= 0, via four halvings followed by a six-term Taylor series.
 *
 * The identity is atan(u) = 2 * atan( u / (1 + sqrt(1 + u^2)) ), from
 * tan(0.5*theta) = sin(theta) / (1 + cos(theta)). Each step at least halves
 * |u| (and collapses it hard for |u| > 1), so four steps put the argument well
 * inside the series' fast-convergence region, then the result is scaled by 16.
 *
 * Fixed iteration count — see the module note.
 */
function atanPos(x: number): number {
  let u = x
  // Four halvings. `u` converges to 0 geometrically; the loop count is a
  // constant, not a function of the input, so this stays deterministic.
  for (let i = 0; i < 4; i++) {
    u = u / (1 + sqrt(1 + u * u))
  }

  const u2 = u * u
  const series =
    u -
    (u * u2) / 3 +
    (u * u2 * u2) / 5 -
    (u * u2 * u2 * u2) / 7 +
    (u * u2 * u2 * u2 * u2) / 9 -
    (u * u2 * u2 * u2 * u2 * u2) / 11
  return series * 16
}

/** atan, four-quadrant. */
export function atan(x: number): number {
  if (x > 0) return atanPos(x)
  if (x < 0) return -atanPos(-x)
  return 0
}

/** Two-argument arctangent, handling the vertical cases explicitly. */
export function atan2(y: number, x: number): number {
  if (x > 0) return atan(y / x)
  if (x < 0) {
    if (y >= 0) return atan(y / x) + PI
    return atan(y / x) - PI
  }
  // x == 0
  if (y > 0) return HALF_PI
  if (y < 0) return -HALF_PI
  return 0
}

// ---------------------------------------------------------------------------
// Exp / log, built on the atanh series
// ---------------------------------------------------------------------------

const LN2 = 0.6931471805599453

/**
 * exp(r) for |r| <= ln(2)/2, Taylor through r^10/10!.
 * Max error ~ (0.347)^11 / 11! = 4.8e-13.
 */
function expSmall(r: number): number {
  let term = 1
  let sum = 1
  for (let k = 1; k <= 10; k++) {
    term = (term * r) / k
    sum += term
  }
  return sum
}

/** 2^n by repeated squaring on a non-negative integer exponent. */
function pow2(n: number): number {
  let result = 1
  let base = 2
  let e = n
  while (e > 0) {
    if (e - trunc(e / 2) * 2 === 1) result *= base
    base *= base
    e = trunc(e / 2)
  }
  return result
}

/**
 * exp(x) via x = k*ln2 + r with |r| <= ln(2)/2, then 2^k * exp(r).
 * Underflow below x = -700 returns 0 rather than relying on platform behaviour.
 */
export function exp(x: number): number {
  if (x > 700) return Number.MAX_VALUE
  if (x < -700) return 0

  const k = floor(x / LN2 + 0.5)
  const r = x - k * LN2

  if (k >= 0) return pow2(k) * expSmall(r)
  // Negative exponent: reciprocal, so the result stays normal.
  return expSmall(r) / pow2(-k)
}

/**
 * atanh(z) for |z| < 1, series through z^13/13. Convergence is geometric in z^2,
 * so with |z| <= 0.172 six terms are already well past double precision.
 */
function atanh(z: number): number {
  const z2 = z * z
  let term = z
  let sum = 0
  for (let k = 0; k < 7; k++) {
    sum += term / (2 * k + 1)
    term *= z2
  }
  return sum
}

/**
 * Natural log via the classic decomposition x = m * 2^e, then
 * log(m) = 2 * atanh((m - 1) / (m + 1)).
 */
export function log(x: number): number {
  if (x < 0) return Number.NaN
  if (x === 0) return Number.NEGATIVE_INFINITY
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY

  let m = x
  let e = 0

  // Binary exponent, by counting halvings. Fixed cost, no log2 rounding worry.
  while (m >= 2) {
    m *= 0.5
    e += 1
  }
  while (m < 1) {
    m *= 2
    e -= 1
  }
  // Fold into [1/sqrt(2), sqrt(2)) so |(m-1)/(m+1)| stays small.
  if (m > 1.4142135623730951) {
    m *= 0.5
    e += 1
  }

  return e * LN2 + 2 * atanh((m - 1) / (m + 1))
}

// ---------------------------------------------------------------------------
// Power and misc
// ---------------------------------------------------------------------------

/**
 * Integer power by square-and-multiply. Exact for integer exponents, and the
 * only `pow` the sim core is allowed. Non-integer exponents are a design error
 * — reach for `exp(n * log(x))` and accept the loss.
 */
export function powInt(base: number, exponent: number): number {
  if (exponent < 0) return 1 / powInt(base, -exponent)
  let result = 1
  let b = base
  let e = exponent
  while (e > 0) {
    if (e - trunc(e / 2) * 2 === 1) result *= b
    b *= b
    e = trunc(e / 2)
  }
  return result
}

/** sqrt(x^2 + y^2), avoiding the platform hypot. */
export function hypot2(x: number, y: number): number {
  return sqrt(x * x + y * y)
}

/** sqrt(x^2 + y^2 + z^2). */
export function hypot3(x: number, y: number, z: number): number {
  return sqrt(x * x + y * y + z * z)
}

/** Smoothstep, used for the residual-bias decay in spec §4.5.1. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Deterministic integer hash -> [0, 1). FNV-1a over a string, then mixed.
 * Used for stable per-id pseudo-randomness without advancing the global stream,
 * so iteration order can never affect the result.
 *
 * Every 32-bit multiply uses `Math.imul`, not `*`. A plain multiply of two 32-bit
 * values can reach 1.8e19, far past 2^53, so the low bits — the only bits that
 * matter here — are lost to float rounding. That failure is silent and produces a
 * badly-clustered output, which is exactly what the uniformity test catches.
 */
export function hashToUnit(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  // Two rounds of a multiply-xorshift finaliser for bit dispersion.
  h ^= h >>> 16
  h = Math.imul(h, 2246822507) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 3266489909) >>> 0
  h ^= h >>> 16
  // `^` yields a SIGNED int32 in JavaScript, so `h` can be negative here.
  // Coerce back to unsigned before scaling, or the function returns values in
  // [-0.5, 0.5) and every downstream bucketing silently loses half its range.
  return (h >>> 0) / 4294967296
}