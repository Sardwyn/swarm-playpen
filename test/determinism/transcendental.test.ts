/**
 * ADR-001 §2.3 — the transcendental ban.
 *
 * `Math.sin`, `Math.cos`, `Math.exp`, `Math.log` and `Math.pow` are
 * implementation-defined in ECMAScript. V8, SpiderMonkey and JavaScriptCore may
 * each return a different last bit. One call in a heading update means the run
 * is bit-identical on your machine forever — all local tests pass — and divergent
 * on anyone else's, compounding through the pose graph.
 *
 * The test greps the sim core for the banned identifiers. It has to be a grep,
 * because the whole failure is that it looks correct locally.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SIM_ROOT = join(process.cwd(), 'src', 'sim')

const BANNED = ['Math.sin', 'Math.cos', 'Math.tan', 'Math.exp', 'Math.log', 'Math.pow', 'Math.atan', 'Math.atan2', 'Math.hypot', 'Math.random']

/**
 * Strip comments before grepping.
 *
 * The sim core *names* these functions constantly — `math.ts`'s own docstring
 * explains why they are banned, and plenty of comments cite them. Grepping raw
 * source therefore reports the documentation as a violation, and the tempting
 * fix is to weaken the ban rather than fix the test. Comments are not code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out.sort()
}

/**
 * `Math.trunc`, `Math.floor` and `Math.sqrt` are allowed: IEEE-754 specifies
 * them exactly. `Math.abs`/`Math.min`/`Math.max` are not in the banned list
 * because they are exact comparisons, not approximations.
 */
describe('transcendental ban', () => {
  it('no module under src/sim calls a platform transcendental', () => {
    const offenders: string[] = []
    for (const file of walk(SIM_ROOT)) {
      // math.ts is NOT exempt. It is where the replacements live, so a
      // self-reference there would defeat the entire point of the ban.
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const banned of BANNED) {
        if (source.includes(banned)) {
          offenders.push(`${file.replace(process.cwd(), '.')}: ${banned}`)
        }
      }
    }
    expect(
      offenders,
      `Platform transcendentals in the sim core (ADR-001 §2.3):\n${offenders.join('\n')}\n` +
        `Use the replacements in src/sim/math.ts.`,
    ).toEqual([])
  })

  it('the sim core defines its own transcendental replacements', async () => {
    const math = await import('../../src/sim/math.ts')
    for (const name of ['sin', 'cos', 'atan', 'atan2', 'exp', 'log', 'powInt']) {
      expect(typeof (math as Record<string, unknown>)[name], `math.${name} missing`).toBe('function')
    }
  })
})