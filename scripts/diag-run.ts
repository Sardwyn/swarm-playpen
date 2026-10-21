import { loadHouse01 } from '../src/sim/world/content.ts'
import { createRun, defaultConfig, step } from '../src/sim/sim/run.ts'
import { coverage } from '../src/sim/world/geometry.ts'

const house = loadHouse01()
const run = createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 0, missionSeconds: 200 }), {
  x: -4.5,
  z: 0.0,
  theta: 0.0,
})

console.log('tick    x        z      theta   plan idx  battery  cov%    moved')
let stalls = 0
let prev = { x: -4.5, z: 0.0 }

for (let t = 0; t < 2000; t++) {
  step(run)
  const a = run.agents[0]!
  const p = a.pose as { x: number; z: number; theta: number }
  const moved = Math.hypot(p.x - prev.x, p.z - prev.z)
  if (moved < 0.001) stalls++
  prev = { x: p.x, z: p.z }

  if (t % 100 === 0) {
    const cov = coverage(run.grid, run.mask, 2)
    console.log(
      `${String(t).padStart(4)} ${p.x.toFixed(2).padStart(7)} ${p.z.toFixed(2).padStart(7)} ${p.theta.toFixed(2).padStart(7)} ` +
        `${String(a.plan.length).padStart(5)} ${String(a.planIndex).padStart(4)} ${a.battery.toFixed(3)} ${(cov.observedFraction * 100).toFixed(1).padStart(6)}  ${moved.toFixed(4)}` +
        (moved < 0.001 ? ' STALL' : ''),
    )
  }
}

const cov = coverage(run.grid, run.mask, 2)
const a = run.agents[0]!
const p = a.pose as { x: number; z: number }
console.log(`\nfinal coverage ${(cov.observedFraction * 100).toFixed(2)}%  observed ${cov.observedCells}/${cov.totalCells}`)
console.log(`final pose ${p.x.toFixed(2)}, ${p.z.toFixed(2)}  battery ${a.battery.toFixed(3)}  stalled ticks ${stalls}/2000`)
console.log(`goal ${JSON.stringify(a.goal)}  planLen ${a.plan.length} idx ${a.planIndex}`)