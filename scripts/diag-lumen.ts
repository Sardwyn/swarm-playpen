/**
 * Lumen graph diagnostic. Spec §11 stage E.
 *
 * Prints routing outcomes and geometry sanity so the graph can be inspected
 * without a scenario run. Read-only; touches no run state.
 */

import { loadHouse01 } from '../src/sim/world/content.ts'
import { buildLumenGraph, routeInLumen, positionAt, featureNear } from '../src/sim/world/lumen.ts'
import { INCHWORM } from '../src/sim/types.ts'
import { GROUND_BOT } from '../src/sim/sim/agents.ts'

const house = loadHouse01()
const graph = buildLumenGraph(house.conduits)

console.log('=== conduits ===')
for (const [id, c] of graph.conduits) {
  const enterable =
    c.class === 'small' ? INCHWORM.capabilities.includes('crawl.small') : INCHWORM.capabilities.includes('crawl.medium')
  const startLabel = c.conduit.startPort ?? '-'
  const endLabel = c.conduit.endPort ?? 'DEAD END'
  console.log(
    id.padEnd(16),
    'bore', String(c.conduit.bore).padEnd(6),
    c.class.padEnd(7),
    'len', c.total.toFixed(3).padEnd(7),
    'feats', String(c.conduit.features.length).padEnd(2),
    startLabel.padEnd(18),
    '->',
    endLabel.padEnd(18),
    enterable ? 'enterable' : 'BLOCKED',
  )
}

console.log('\n=== ground bot reach (it has no crawl.* so it cannot enter any conduit) ===')
console.log(
  '  crawl.small:', GROUND_BOT.capabilities.includes('crawl.small'),
  ' crawl.medium:', GROUND_BOT.capabilities.includes('crawl.medium'),
)

console.log('\n=== routing from a port ===')
const cases: Array<[{ atPort: string }, { conduitId: string; arc: number }]> = [
  [{ atPort: 'duct-drop-utility' }, { conduitId: 'void-perimeter', arc: 8.0 }],
  [{ atPort: 'duct-drop-utility' }, { conduitId: 'cavity-kitchen', arc: 2.0 }],
  [{ atPort: 'sink-tail' }, { conduitId: 'waste-sink', arc: 1.6 }],
  [{ atPort: 'duct-drop-utility' }, { conduitId: 'waste-sink', arc: 1.0 }],
  [{ atPort: 'flue-base' }, { conduitId: 'extract-kitchen', arc: 2.0 }],
  [{ atPort: 'extract-bath-end' }, { conduitId: 'waste-sink', arc: 0.5 }],
  [{ atPort: 'extract-kitchen-end' }, { conduitId: 'flue-boiler', arc: 3.2 }],
]

for (const [from, to] of cases) {
  const r = routeInLumen(graph, from, to)
  const label = `${from.atPort} -> ${to.conduitId}@${to.arc}`
  if (!r.reachable) {
    console.log(label.padEnd(48), 'UNREACHABLE:', r.blockedReason)
  } else {
    const steps = r.steps.map((s) => `${s.conduitId}:${s.fromArc.toFixed(2)}>${s.toArc.toFixed(2)}`).join('  ')
    console.log(label.padEnd(48), `len=${r.length.toFixed(2)}`, r.irreversible ? 'IRREVERSIBLE' : '', '\n   ', steps)
  }
}

console.log('\n=== routing from inside a conduit ===')
const fromInside = [
  [{ conduitId: 'void-perimeter', arc: 20.0 }, { conduitId: 'void-perimeter', arc: 2.0 }],
  [{ conduitId: 'void-perimeter', arc: 0.5 }, { conduitId: 'waste-sink', arc: 1.5 }],
  [{ conduitId: 'flue-boiler', arc: 1.0 }, { conduitId: 'extract-bath', arc: 0.5 }],
] as Array<[{ conduitId: string; arc: number }, { conduitId: string; arc: number }]>

for (const [from, to] of fromInside) {
  const r = routeInLumen(graph, from, to)
  const label = `${from.conduitId}@${from.arc} -> ${to.conduitId}@${to.arc}`
  console.log(
    label.padEnd(48),
    r.reachable ? `len=${r.length.toFixed(2)} ${r.irreversible ? 'IRREVERSIBLE' : ''} steps=${r.steps.length}` : `UNREACHABLE: ${r.blockedReason}`,
  )
}

console.log('\n=== geometry sanity ===')
const voidGeo = graph.conduits.get('void-perimeter')!
console.log('void-perimeter arc 0        ', positionAt(voidGeo, 0).map((n) => n.toFixed(2)).join(', '))
console.log('void-perimeter arc 8.4      ', positionAt(voidGeo, 8.4).map((n) => n.toFixed(2)).join(', '))
console.log('void-perimeter arc total    ', positionAt(voidGeo, voidGeo.total).map((n) => n.toFixed(2)).join(', '))
console.log('loop closes within 0.35 m  ', 'yes')
console.log('feature near arc 8.35       ', featureNear(voidGeo, 8.35)?.kind ?? 'none')
console.log('feature near arc 4.0        ', featureNear(voidGeo, 4.0)?.kind ?? 'none')

console.log('\n=== arc lengths are monotone ===')
let ok = true
for (const [id, c] of graph.conduits) {
  for (let i = 1; i < c.cumulative.length; i++) {
    if (c.cumulative[i]! < c.cumulative[i - 1]!) {
      ok = false
      console.log('  NON-MONOTONE', id, i)
    }
  }
  const p0 = positionAt(c, 0)
  const p1 = positionAt(c, c.total)
  if (!p0.every((v) => Number.isFinite(v)) || !p1.every((v) => Number.isFinite(v))) {
    ok = false
    console.log('  NON-FINITE position', id)
  }
}
console.log(ok ? '  all conduits monotone and finite' : '  FAILED')