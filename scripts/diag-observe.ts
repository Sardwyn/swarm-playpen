import { loadHouse01 } from '../src/sim/world/content.ts'
import { createRun, defaultConfig, runToCompletion } from '../src/sim/sim/run.ts'
import { coverage, worldToCellX, worldToCellZ, gridIndex, CELL_OCCUPIED } from '../src/sim/world/geometry.ts'
import { castRay, markRayObservation } from '../src/sim/world/geometry.ts'
import { createGrid } from '../src/sim/world/geometry.ts'

const house = loadHouse01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }
const run = runToCompletion(
  createRun(house, defaultConfig({ seed: 1, noiseMultiplier: 1, missionSeconds: 300 }), spawn),
)

const g = run.grid
const cov = coverage(g, run.mask, 2)
console.log(`coverage ${(cov.observedFraction * 100).toFixed(2)}%  observed ${cov.observedCells}/${cov.totalCells}  tick ${run.tick}`)

const probe = (label: string, x: number, z: number) => {
  const cx = worldToCellX(g, x)
  const cz = worldToCellZ(g, z)
  const i = gridIndex(g, cx, cz)
  console.log(`  ${label.padEnd(22)} cell ${cx},${cz} state=${g.cells[i]} mask=${run.mask[i]} observed=${g.observedCount[i]}`)
}

console.log('\noccupied cells:')
probe('west wall', -5.95, 0)
probe('pier-living', -0.45, -1.0)
probe('pier-corridor', 0.45, 2.4)
probe('sofa', 0.0, 1.17)
probe('fridge', 5.4, -0.7)

console.log('\nfree cells:')
probe('spawn', -4.5, 0)
probe('hall mid', -4.0, 0.5)

console.log('\n--- isolated ray-marking test ---')
const test = createGrid(-6, -4, 12, 8)
// Stamp a wall at x = -2 across the middle.
for (let cz = 0; cz < test.height; cz++) {
  for (let cx = worldToCellX(test, -2); cx <= worldToCellX(test, -1.95); cx++) {
    test.cells[gridIndex(test, cx, cz)] = CELL_OCCUPIED
  }
}
const testMask = new Uint8Array(test.width * test.height).fill(1)
for (let cz = 0; cz < test.height; cz++) for (let cx = worldToCellX(test, -2); cx <= worldToCellX(test, -1.95); cx++) testMask[gridIndex(test, cx, cz)] = 0
const dist = castRay(test, testMask, -4, 0, 1, 0, 5)
console.log(`  ray from (-4,0) east hits at distance ${dist.toFixed(4)} (wall starts at x=-2, so expect ~2.0)`)
markRayObservation(test, testMask, -4, 0, 1, 0, dist)
const wcx = worldToCellX(test, -1.975)
const wcz = worldToCellZ(test, 0)
const wallIdx = gridIndex(test, wcx, wcz)
console.log(`  wall cell ${wcx},${wcz} surfaceCount=${wallIdx === undefined ? '?' : test.surfaceCount[wallIdx]}`)
let totalObserved = 0
for (let i = 0; i < test.observedCount.length; i++) if (test.observedCount[i]! > 0) totalObserved++
console.log(`  total observed cells after one ray: ${totalObserved}`)
