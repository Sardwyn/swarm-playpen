import { loadHouse01 } from '../src/sim/world/content.ts'
import { loadAnomalies01 } from '../src/sim/world/anomalies.ts'
import { createRun, defaultConfig, runToCompletion, detectThisTick } from '../src/sim/sim/run.ts'
import { coverage, CELL_OCCUPIED, CELL_BLOCKED, cellCenterX, cellCenterZ } from '../src/sim/world/geometry.ts'
import { DETECTOR_THRESHOLDS } from '../src/sim/sim/run.ts'

const house = loadHouse01()
const truth = loadAnomalies01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }

const run = runToCompletion(
  createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300 }), spawn),
)

console.log('--- ground ports (blocked-vent detector iterates these) ---')
for (const p of house.ports) {
  console.log(`  ${p.id} manifolds ${p.a}/${p.b} at (${p.position[0]}, ${p.position[1]}, ${p.position[2]})`)
}
console.log('bv-01 truth at', truth.anomalies.find((a) => a.id === 'bv-01')?.position)

console.log('\n--- air field near the boiler dock port ---')
const dock = house.docks[0]!
const { sampleField } = await import('../src/sim/world/fields.ts')
for (const [dx, dz] of [[0,0],[0.5,0],[-0.5,0],[0,0.5],[-0.3,0.45]] as Array<[number,number]>) {
  console.log(`  (${(dock.position[0] + dx).toFixed(2)}, ${(dock.position[2] + dz).toFixed(2)}) air=${sampleField(run.fields.air, dock.position[0] + dx, dock.position[2] + dz).toFixed(4)}`)
}
console.log('  ambient air =', run.fields.air.baselineAt(0, 0).toFixed(4))

console.log('\n--- occupied components (crack proxy input) ---')
// Recompute the proxy's component census inline.
const g = run.grid
const visited = new Uint8Array(g.width * g.height)
const comps: Array<{ cells: number; spanX: number; spanZ: number; obs: number }> = []
for (let sz = 1; sz < g.height - 1; sz++) {
  for (let sx = 1; sx < g.width - 1; sx++) {
    const seed = sz * g.width + sx
    if (g.cells[seed] !== CELL_OCCUPIED || visited[seed] === 1) continue
    const stack = [seed]
    visited[seed] = 1
    let count = 0, minX = sx, maxX = sx, minZ = sz, maxZ = sz, obs = 0
    while (stack.length > 0) {
      const i = stack.pop()!
      const ix = i % g.width
      const iz = (i - ix) / g.width
      count++
      if (g.observedCount[i]! > 0) obs++
      minX = Math.min(minX, ix); maxX = Math.max(maxX, ix)
      minZ = Math.min(minZ, iz); maxZ = Math.max(maxZ, iz)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = ix + dx, nz = iz + dz
        if (nx < 0 || nz < 0 || nx >= g.width || nz >= g.height) continue
        const ni = nz * g.width + nx
        if (visited[ni] === 1 || g.cells[ni] !== CELL_OCCUPIED) continue
        visited[ni] = 1
        stack.push(ni)
      }
    }
    comps.push({ cells: count, spanX: maxX - minX + 1, spanZ: maxZ - minZ + 1, obs })
  }
}
comps.sort((a, b) => a.cells - b.cells)
for (const c of comps.slice(0, 10)) {
  const thin = Math.min(c.spanX, c.spanZ) <= 2
  const score = (3 - Math.min(c.spanX, c.spanZ)) + Math.max(c.spanX, c.spanZ) / 6
  console.log(
    `  cells ${String(c.cells).padStart(5)} span ${c.spanX}x${c.spanZ} obs ${c.obs} thin=${thin} score=${thin ? score.toFixed(2) : '-'} ` +
      `passes(thresh ${DETECTOR_THRESHOLDS.crackProxy})=${thin && c.cells <= 60 && c.cells >= 4 && c.obs >= c.cells * 0.5 && score >= DETECTOR_THRESHOLDS.crackProxy}`,
  )
}

console.log('\n--- thermal candidates near pi-01 (5.25, -1.5) ---')
for (const c of run.candidates) {
  if (c.predictedClass !== 'thermal_anomaly') continue
  const d = Math.hypot(c.x - 5.25, c.z + 1.5)
  if (d < 2.5) console.log(`  ${c.id} at (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) mag ${c.magnitude.toFixed(2)} conf ${c.confidence.toFixed(2)} d ${d.toFixed(2)}`)
}
console.log('pest candidates:', run.candidates.filter((c) => c.predictedClass === 'pest_indicator').length)

void coverage; void CELL_BLOCKED; void cellCenterX; void cellCenterZ; void detectThisTick
