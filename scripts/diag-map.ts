import { loadHouse01 } from '../src/sim/world/content.ts'
import { createRun, defaultConfig } from '../src/sim/sim/run.ts'
import { findPath } from '../src/sim/nav/astar.ts'

const house = loadHouse01()
const run = createRun(house, defaultConfig(), { x: -4.5, z: 0.0, theta: 0.0 })
const g = run.grid

let passable = 0
let total = 0
for (let i = 0; i < g.cells.length; i++) {
  total++
  if (run.mask[i] === 1) passable++
}
console.log(`grid ${g.width}x${g.height} = ${total} cells, passable ${passable}`)

// Row map: '#' occupied, '.' blocked(nav ok), ' ' passable, 'S' spawn
let out = ''
for (let cz = 0; cz < g.height; cz += 2) {
  let row = ''
  for (let cx = 0; cx < g.width; cx++) {
    const i = cz * g.width + cx
    const sx = g.minX + (cx + 0.5) * 0.05
    const sz = g.minZ + (cz + 0.5) * 0.05
    if (Math.abs(sx + 4.5) < 0.05 && Math.abs(sz) < 0.05) row += 'S'
    else if (g.cells[i] === 2) row += '#'
    else if (g.cells[i] === 3) row += '.'
    else if (run.mask[i] === 1) row += ' '
    else row += '~'
  }
  out += row + '\n'
}
console.log(out)

console.log('--- room reachability ---')
for (const room of house.rooms) {
  const cx = (room.aabb.minX + room.aabb.maxX) / 2
  const cz = (room.aabb.minZ + room.aabb.maxZ) / 2
  const p = findPath(run.grid, run.mask, -4.5, 0, cx, cz)
  console.log(`${room.id.padEnd(9)} centre (${cx.toFixed(2)}, ${cz.toFixed(2)}) reached=${p.reached} len=${p.length.toFixed(2)} expanded=${p.expanded}`)
}

console.log('--- is the dock cell itself passable? ---')
const dock = house.docks[0]!
const dcx = Math.floor((dock.position[0]! - g.minX) / 0.05)
const dcz = Math.floor((dock.position[2]! - g.minZ) / 0.05)
console.log(`dock (${dock.position[0]}, ${dock.position[2]}) cell ${dcx},${dcz} state=${g.cells[dcz * g.width + dcx]} mask=${run.mask[dcz * g.width + dcx]}`)
const dp = findPath(run.grid, run.mask, -4.5, 0, dock.position[0]!, dock.position[2]!)
console.log(`dock path reached=${dp.reached} len=${dp.length.toFixed(2)}`)