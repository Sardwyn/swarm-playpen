/**
 * Seeded PRNG. ADR-001 §2.4.
 *
 * `Math.random()` is banned in `sim/` because it is unseedable, which would make
 * every run unique and every comparison meaningless. This is the only source of
 * randomness in the simulation core.
 *
 * mulberry32: 32-bit state, uniform in [0, 1), passes gjrand's basic suite, and
 * the whole state is one integer — which means a snapshot is one number and a
 * replay is exact.
 *
 * Every draw returns a float. For integers, `int` rejects a non-integer bound
 * rather than rounding silently, because a fractional cell count is a content
 * bug and should surface at the call site.
 */

import type { SimConfig } from './types.ts'

export class Rng {
  private state: number
  private readonly seed: number
  private draws: number

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new Error(`Rng seed must be an integer, got ${seed}`)
    }
    this.seed = seed >>> 0
    this.state = this.seed
    this.draws = 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.draws++
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform in [lo, hi). */
  uniform(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo)
  }

  /**
   * Uniform integer in [0, bound). Rejects a fractional bound — see class note.
   *
   * Uses the "multiply and floor" form, which is modulo-free and therefore has no
   * bias that grows with the bound. The tiny residual bias of multiply-and-floor
   * is irrelevant at the scale of a 10 Hz sim and, more importantly, is stable,
   * unlike a modulo which would produce a fixed skew toward low indices.
   */
  int(bound: number): number {
    if (!Number.isInteger(bound)) {
      throw new Error(`Rng.int bound must be an integer, got ${bound}`)
    }
    if (bound <= 0) {
      throw new Error(`Rng.int bound must be positive, got ${bound}`)
    }
    return Math.floor(this.next() * bound)
  }

  /**
   * Standard normal via Box-Muller. Consumes exactly two draws and discards one
   * — the naive version's third value is free but caching it would make the draw
   * count depend on call parity, which is a determinism trap when two branches
   * consume normals unevenly.
   */
  normal(mean = 0, sigma = 1): number {
    // Imported lazily to keep math.ts free of any dependency on this module.
    const { sqrt, log, cos, TWO_PI } = mathRef
    let u1 = this.next()
    if (u1 < 1e-12) u1 = 1e-12
    const u2 = this.next()
    return mean + sigma * sqrt(-2 * log(u1)) * cos(TWO_PI * u2)
  }

  /** Current internal state. One integer — the whole reason for mulberry32. */
  snapshot(): number {
    return this.state
  }

  /** Restore a snapshot, for exact replay of a partial run. */
  restore(state: number): void {
    this.state = state >>> 0
  }

  get drawCount(): number {
    return this.draws
  }

  get initialSeed(): number {
    return this.seed
  }
}

// Bound once so `normal` does not allocate an import cycle per call, and so the
// transcendental ban test can see a single reference point to audit.
import * as mathModule from './math.ts'
const mathRef = {
  sqrt: mathModule.sqrt,
  log: mathModule.log,
  cos: mathModule.cos,
  TWO_PI: mathModule.TWO_PI,
}

export function rngFromConfig(config: SimConfig): Rng {
  return new Rng(config.seed)
}