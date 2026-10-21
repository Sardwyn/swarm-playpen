/**
 * ADR-001 §2.2 — the sim/view boundary, enforced as a failing test.
 *
 * The reason this is a test and not a convention: the failure is not someone
 * ignoring the rule, it is someone adding `import { Vector3 } from 'three'` to a
 * pose calculation because it saves a line. That works, it survives review, and
 * it couples the simulation to a rendering library's coordinate conventions,
 * matrix layout and version.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SIM_ROOT = join(process.cwd(), 'src', 'sim')

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
  // Sorted, so a failure message is stable.
  return out.sort()
}

describe('sim/view boundary', () => {
  it('no module under src/sim imports three', () => {
    const offenders: string[] = []
    for (const file of walk(SIM_ROOT)) {
      const source = readFileSync(file, 'utf8')
      if (/from\s+['"]three['"]/.test(source) || /import\s*\(\s*['"]three['"]\s*\)/.test(source)) {
        offenders.push(file.replace(process.cwd(), '.'))
      }
    }
    expect(
      offenders,
      `Engine import in the simulation core (ADR-001 §2.2):\n${offenders.join('\n')}\n` +
        `The sim core must carry no renderer types, or a rendering bug becomes a ` +
        `simulation bug and runs stop being reproducible.`,
    ).toEqual([])
  })

  it('src/sim exists and contains the modules the spec names', () => {
    const files = walk(SIM_ROOT).map((f) => f.replace(process.cwd(), '').replace(/\\/g, '/'))
    for (const required of [
      '/sim/math.ts',
      '/sim/rng.ts',
      '/sim/types.ts',
      '/sim/eventlog.ts',
      '/sim/world/geometry.ts',
      '/sim/world/content.ts',
      '/sim/world/fields.ts',
      '/sim/world/anomalies.ts',
      '/sim/nav/astar.ts',
      '/sim/sensors/depth.ts',
      '/sim/sensors/thermal.ts',
      '/sim/sensors/scalar.ts',
      '/sim/sensors/noise.ts',
      '/sim/sim/agents.ts',
      '/sim/sim/run.ts',
      '/sim/sim/detectors.ts',
      '/sim/sim/cluster.ts',
      '/sim/jobs/schema.ts',
      '/sim/jobs/market.ts',
      '/sim/jobs/coverage.ts',
      '/sim/report/metrics.ts',
      '/sim/report/report.ts',
      '/sim/report/frame.ts',
    ]) {
      expect(files.some((f) => f.endsWith(required)), `missing ${required}`).toBe(true)
    }
  })

  it('no module under src/sim touches a browser global', () => {
    // The tsconfig has to include the DOM lib, because `src/view/` needs it and one
    // config types the whole package. That makes `document`, `window` and friends
    // *legal* in the sim — so the purity that used to come from the compiler has to
    // come from here instead.
    //
    // It matters: a sim that can read `window.devicePixelRatio` or
    // `performance.now()` is a sim whose results depend on the machine it ran on,
    // which breaks the determinism guarantee (ADR-001 §1.4) at the root.
    const BANNED = ['document', 'window', 'navigator', 'localStorage', 'performance.now']
    const offenders: string[] = []
    for (const file of walk(SIM_ROOT)) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
      for (const banned of BANNED) {
        if (source.includes(banned)) {
          offenders.push(`${file.replace(process.cwd(), '.')}: ${banned}`)
        }
      }
    }
    expect(
      offenders,
      `Browser globals in the simulation core. The sim must run headless in Node and\n` +
        `produce the same numbers in a browser (ADR-001 §2.2).\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('the viewer exists and is the only place three is imported', () => {
    const viewerRoot = join(process.cwd(), 'src', 'view')
    const files = walk(viewerRoot)
    const importers = files.filter((f) => /from\s+['"]three['"]/.test(readFileSync(f, 'utf8')))
    // Proves the viewer is real and exercised by the build, rather than a directory
    // that exists in a spec and nowhere else.
    expect(files.length).toBeGreaterThanOrEqual(3)
    expect(importers.length).toBeGreaterThan(0)
    for (const f of importers) {
      expect(f.startsWith(viewerRoot)).toBe(true)
    }
  })
})