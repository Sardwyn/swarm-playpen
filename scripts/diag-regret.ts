/**
 * S8 — the kill condition, printed. 20 seeds per arm.
 *
 * Three arms because a result that says "the auction is worth nothing" is only
 * trustworthy if it was measured where the auction's other terms have a chance to
 * matter. At nominal they provably do not: battery is not binding for a bot that
 * spends 5% of a 38 Wh pack, and load cannot outweigh distance unless two candidates
 * are within half a metre of equally far.
 */

import { loadHouse01 } from '../src/sim/world/content.ts'
import { createRun, defaultConfig, runToCompletion } from '../src/sim/sim/run.ts'
import { GROUND_BOT, GROUND_BOT_2 } from '../src/sim/sim/agents.ts'
import { INCHWORM } from '../src/sim/types.ts'
import { allocationRegret, auctionVerdict } from '../src/sim/jobs/market.ts'

const house = loadHouse01()
const spawn = { x: -4.5, z: 0.0, theta: 0.0 }
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1)

const ARMS = [
  {
    label: 'nominal battery',
    make: (seed: number) =>
      createRun(
        house,
        defaultConfig({ seed, noiseMultiplier: 1, missionSeconds: 300, agents: [GROUND_BOT, GROUND_BOT_2] }),
        spawn,
      ),
  },
  {
    label: 'degraded battery (S6 6c, 30%)',
    make: (seed: number) =>
      createRun(
        house,
        defaultConfig({
          seed,
          noiseMultiplier: 1,
          missionSeconds: 300,
          agents: [GROUND_BOT, GROUND_BOT_2],
          initialBatteryFraction: 0.3,
        }),
        spawn,
      ),
  },
  {
    label: 'with the crawler (irreversible risk binds)',
    make: (seed: number) =>
      createRun(
        house,
        defaultConfig({
          seed,
          noiseMultiplier: 1,
          missionSeconds: 300,
          agents: [GROUND_BOT, GROUND_BOT_2, INCHWORM],
          inchwormHomePort: 'sink-tail',
        }),
        spawn,
      ),
  },
]

console.log('S8 — allocation regret over 20 seeds, three arms\n')
console.log('arm'.padEnd(44) + 'mean'.padStart(9) + 'p95'.padStart(9) + 'worst'.padStart(9) + 'contested'.padStart(11) + '  verdict')

for (const arm of ARMS) {
  const runs = SEEDS.map((s) => runToCompletion(arm.make(s)))
  const regret = allocationRegret(runs.flatMap((r) => r.regretSamples))
  const contested = runs.reduce((n, r) => n + r.contestedAwards, 0)
  const verdict = auctionVerdict(regret, contested)

  const nonZero = runs
    .flatMap((r) => r.regretSamples)
    .filter((s) => s.bestDistance > 0.05)
    .map((s) => Math.max(0, (s.winnerDistance - s.bestDistance) / s.bestDistance))
    .filter((v) => v > 0).length

  console.log(
    arm.label.padEnd(44) +
      `${(regret.mean * 100).toFixed(3)}%`.padStart(9) +
      `${(regret.p95 * 100).toFixed(3)}%`.padStart(9) +
      `${(regret.worst * 100).toFixed(3)}%`.padStart(9) +
      String(contested).padStart(11) +
      '  ' +
      verdict.status,
  )
  console.log(
    ' '.repeat(44) +
      `samples ${regret.samples}, of which ${nonZero} were non-zero (the winner was not the nearest bidder)`,
  )
}

console.log('\nkill condition: if mean regret < 2% across 20 seeds, delete the auction and keep greedy.')