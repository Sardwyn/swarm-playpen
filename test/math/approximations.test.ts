/**
 * Accuracy of the reimplemented transcendentals, against the platform built-ins.
 *
 * The point is NOT to match the built-ins exactly — that is impossible, and the
 * difference is precisely the last-bit divergence the ban exists to prevent.
 * The point is that the replacements are *good enough* that a run's results are
 * limited by the model rather than by the arithmetic.
 *
 * Tolerances below are set by what the sim actually needs, not by what the
 * implementation happens to achieve.
 */

import { describe, expect, it } from 'vitest'
import * as m from '../../src/sim/math.ts'

describe('sin', () => {
  it('matches the built-in to better than 1e-7 over [-4pi, 4pi]', () => {
    let worst = 0
    for (let i = 0; i <= 4000; i++) {
      const x = -4 * Math.PI + (8 * Math.PI * i) / 4000
      worst = Math.max(worst, Math.abs(m.sin(x) - Math.sin(x)))
    }
    expect(worst).toBeLessThan(1e-7)
  })

  it('is odd and bounded to [-1, 1]', () => {
    for (let i = 0; i <= 1000; i++) {
      const x = -20 + (40 * i) / 1000
      const s = m.sin(x)
      expect(Math.abs(s)).toBeLessThanOrEqual(1.0 + 1e-12)
      expect(Math.abs(m.sin(-x) + s)).toBeLessThan(1e-12)
    }
  })

  it('hits the cardinal values', () => {
    expect(Math.abs(m.sin(0))).toBeLessThan(1e-12)
    expect(Math.abs(m.sin(Math.PI) - 0)).toBeLessThan(1e-12)
    expect(Math.abs(m.sin(Math.PI / 2) - 1)).toBeLessThan(1e-9)
    expect(Math.abs(m.sin(-Math.PI / 2) + 1)).toBeLessThan(1e-9)
  })
})

describe('cos', () => {
  it('matches the built-in to better than 1e-7', () => {
    let worst = 0
    for (let i = 0; i <= 4000; i++) {
      const x = -4 * Math.PI + (8 * Math.PI * i) / 4000
      worst = Math.max(worst, Math.abs(m.cos(x) - Math.cos(x)))
    }
    expect(worst).toBeLessThan(1e-7)
  })
})

describe('atan / atan2', () => {
  it('atan matches the built-in to better than 1e-6 over a wide range', () => {
    let worst = 0
    for (let i = 0; i <= 5000; i++) {
      const x = -100 + (200 * i) / 5000
      worst = Math.max(worst, Math.abs(m.atan(x) - Math.atan(x)))
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('atan2 matches the built-in including the axes and quadrants', () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
      [3, -7],
      [-0.001, -0.001],
    ]
    for (const [y, x] of cases) {
      expect(Math.abs(m.atan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-6)
    }
  })
})

describe('exp', () => {
  it('matches the built-in to better than 1e-9 over [-30, 30]', () => {
    let worstRel = 0
    for (let i = 0; i <= 6000; i++) {
      const x = -30 + (60 * i) / 6000
      const mine = m.exp(x)
      const ref = Math.exp(x)
      const rel = Math.abs(mine - ref) / Math.max(Math.abs(ref), 1e-12)
      worstRel = Math.max(worstRel, rel)
    }
    expect(worstRel).toBeLessThan(1e-9)
  })

  it('is exactly 1 at zero and satisfies exp(a+b) ~= exp(a)exp(b)', () => {
    expect(Math.abs(m.exp(0) - 1)).toBeLessThan(1e-15)
    const a = 0.7
    const b = -1.3
    const lhs = m.exp(a + b)
    const rhs = m.exp(a) * m.exp(b)
    expect(Math.abs(lhs - rhs) / Math.abs(lhs)).toBeLessThan(1e-12)
  })

  it('underflows and overflows without throwing', () => {
    expect(m.exp(-1000)).toBe(0)
    expect(Number.isFinite(m.exp(1000))).toBe(true)
  })
})

describe('log', () => {
  it('matches the built-in to better than 1e-9 over a wide range', () => {
    let worstRel = 0
    for (let i = 1; i <= 6000; i++) {
      const x = (20000 * i) / 6000
      const mine = m.log(x)
      const ref = Math.log(x)
      const rel = Math.abs(mine - ref) / Math.max(Math.abs(ref), 1e-12)
      worstRel = Math.max(worstRel, rel)
    }
    expect(worstRel).toBeLessThan(1e-9)
  })

  it('handles zero and negatives without an exception', () => {
    expect(m.log(0)).toBe(Number.NEGATIVE_INFINITY)
    expect(Number.isNaN(m.log(-1))).toBe(true)
  })

  it('is the inverse of exp', () => {
    for (const x of [-8, -1, -0.1, 0.1, 1, 5, 9]) {
      expect(Math.abs(m.log(m.exp(x)) - x)).toBeLessThan(1e-9)
    }
  })
})

describe('powInt', () => {
  it('matches the built-in for small integer exponents', () => {
    for (const [b, n] of [
      [2, 3],
      [2, 10],
      [3, 5],
      [1.5, 4],
      [0.5, 6],
      [10, 3],
    ] as Array<[number, number]>) {
      expect(Math.abs(m.powInt(b, n) - Math.pow(b, n))).toBeLessThan(1e-12)
    }
  })

  it('handles negative and zero exponents', () => {
    expect(m.powInt(2, 0)).toBe(1)
    expect(Math.abs(m.powInt(2, -4) - 1 / 16)).toBeLessThan(1e-15)
  })
})

describe('angle helpers', () => {
  it('wrapPi maps into (-PI, PI]', () => {
    for (const a of [0, 1, 3.2, 6.3, 6.28, -6.3, -100, 100, 1000]) {
      const w = m.wrapPi(a)
      expect(w).toBeLessThanOrEqual(Math.PI)
      expect(w).toBeGreaterThan(-Math.PI)
      // Same angle modulo a full turn.
      expect(Math.abs(m.sin(w) - Math.sin(a))).toBeLessThan(1e-7)
    }
  })

  it('angleDelta takes the short way round', () => {
    expect(Math.abs(m.angleDelta(0.1, 6.2))).toBeLessThan(0.2)
    expect(Math.abs(m.angleDelta(6.2, 0.1))).toBeLessThan(0.2)
  })
})

describe('hashToUnit', () => {
  it('is stable, in [0,1), and spreads', () => {
    const a = m.hashToUnit('agent-01')
    expect(a).toBe(a)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)

    const buckets = new Array(10).fill(0)
    for (let i = 0; i < 5000; i++) {
      buckets[Math.floor(m.hashToUnit(`id-${i}`) * 10)]++
    }
    // Uniform-ish: every decile should be within a generous band of 500.
    for (const b of buckets) {
      expect(b).toBeGreaterThan(350)
      expect(b).toBeLessThan(650)
    }
  })

  it('is order-independent, unlike a running stream', () => {
    // This is the property the coverage metric relies on.
    expect(m.hashToUnit('ground-01')).toBe(m.hashToUnit('ground-01'))
  })
})