import * as m from '../src/sim/math.ts'

console.log('--- sin ---')
for (const x of [0, 0.5, 1, 1.5, Math.PI / 2, 2, 3, Math.PI, 4, 5, 6, 6.28, 6.3, -1, -3, -6.3, 100, 1000]) {
  const mine = m.sin(x)
  const ref = Math.sin(x)
  console.log(
    `x=${x.toFixed(4).padStart(10)}  mine=${mine.toFixed(12).padStart(16)}  ref=${ref.toFixed(12).padStart(16)}  diff=${Math.abs(mine - ref).toExponential(3)}`,
  )
}

console.log('\n--- cos ---')
for (const x of [0, 1, Math.PI / 2, Math.PI, 3, 6.28, 1000]) {
  console.log(`x=${x.toFixed(4).padStart(10)}  mine=${m.cos(x).toFixed(12).padStart(16)}  ref=${Math.cos(x).toFixed(12).padStart(16)}`)
}

console.log('\n--- hashToUnit ---')
const buckets = new Array(10).fill(0)
const samples: number[] = []
for (let i = 0; i < 20; i++) samples.push(m.hashToUnit(`id-${i}`))
console.log(samples.map((v) => v.toFixed(6)).join(' '))
for (let i = 0; i < 5000; i++) buckets[Math.floor(m.hashToUnit(`id-${i}`) * 10)]++
console.log('deciles:', buckets.join(' '))