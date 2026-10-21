/**
 * The command console.
 *
 * ## What this is for
 *
 * A three-dimensional picture of a boat is a *picture*. This is the other half:
 * the numbers, live, while the picture runs. The design brief was a strategic
 * readout — dense, monospaced, precise, everything at once, the machine
 * talking to an operator rather than to an audience.
 *
 * So: three agent cards with live telemetry, a mission panel, an event stream
 * that scrolls, the findings with their confidence, the coverage of each
 * space, a plan view of the engine room with the machines on it, and a timeline
 * with the coverage history on it. Nothing is decorative. Every field is
 * measured, and the ones that are not measured yet say so.
 *
 * ## The one rule
 *
 * **A number on this screen is a number the run produced.** The confidence on a
 * finding is the detector's confidence; the distance is the measured distance;
 * the clock is the simulated clock. Nothing here is a decoration, a placeholder
 * or an estimate, and the panel that would be easiest to fake — "SEVERITY" —
 * is not shown at all, because severity is a human judgement and this is a
 * machine readout.
 */

import type { SimFrame } from '../sim/report/frame.ts'
import type { Take } from '../sim/report/take.ts'
import type { SimEvent } from '../sim/types.ts'
import type { House } from '../sim/world/geometry.ts'

export type ConsoleElements = {
  readonly root: HTMLElement
  update(frame: SimFrame, take: Take, index: number, total: number): void
}

const AGENT_META: Record<string, { readonly label: string; readonly role: string; readonly colour: string }> = {
  ground: { label: 'GROUND-01', role: 'rover · depth, thermal, RH', colour: '#4fd1c5' },
  hover: { label: 'HOVER-01', role: 'quad · raster + raycast', colour: '#68d391' },
  inchworm: { label: 'INCH-01', role: 'crawler · bore scan', colour: '#ffb454' },
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (className !== undefined) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `T+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** How an event reads in the stream. */
function describeEvent(e: SimEvent): string | null {
  switch (e.kind) {
    case 'run.started':
      return 'MISSION START'
    case 'run.finished':
      return 'MISSION COMPLETE'
    case 'agent.faulted':
      return `${e.agentId ?? '—'} FAULTED`
    case 'agent.stranded':
      return `${e.agentId ?? '—'} STRANDED`
    case 'agent.battery_critical':
      return `${e.agentId ?? '—'} BATTERY CRITICAL`
    case 'agent.calibrated':
      return `${e.agentId ?? '—'} CALIBRATED`
    case 'job.announced':
      return `JOB ${e.jobId ?? '—'} OPENED`
    case 'job.awarded':
      return `${e.jobId ?? '—'} → ${e.agentId ?? '—'}`
    case 'job.done':
      return `JOB ${e.jobId ?? '—'} DONE`
    case 'job.failed':
      return `JOB ${e.jobId ?? '—'} FAILED`
    case 'job.handed_off':
      return `${e.jobId ?? '—'} HANDED OFF`
    case 'anomaly.candidate':
      return `${e.agentId ?? '—'} CANDIDATE at ${(e.data['x'] ?? 0).toFixed(1)},${(
        e.data['z'] ?? 0
      ).toFixed(1)}`
    case 'cluster.formed':
      return 'CLUSTER FORMED'
    default:
      return null
  }
}

export function buildConsole(root: HTMLElement, house: House): ConsoleElements {
  root.innerHTML = `
    <div class="console">
      <header class="topbar">
        <div class="brand">
          <span class="mark"></span>
          <span class="title">SWARM INSPECTION</span>
          <span class="sep">/</span>
          <span class="vessel">${house.name ?? house.id}</span>
        </div>
        <div class="topstats">
          <div class="tstat"><b id="c-clock">T+00:00</b><i>sim clock</i></div>
          <div class="tstat"><b id="c-tick">0</b><i>ticks</i></div>
          <div class="tstat"><b id="c-coverage">—</b><i>engine room</i></div>
          <div class="tstat"><b id="c-found">—</b><i>faults found</i></div>
          <div class="tstat alarm"><b id="c-miss">—</b><i>unreachable</i></div>
          <button id="c-report" class="tbtn">REPORT</button>
        </div>
      </header>

      <aside class="rail left">
        <section class="block">
          <h2>SWARM</h2>
          <div id="c-agents"></div>
        </section>
        <section class="block">
          <h2>MISSION</h2>
          <table id="c-mission"></table>
        </section>
        <section class="block grow">
          <h2>PLAN · ENGINE ROOM</h2>
          <canvas id="c-minimap" width="320" height="230"></canvas>
          <div class="legend">
            <span><i style="background:#4fd1c5"></i>coverage</span>
            <span><i style="background:#f6e05e"></i>finding</span>
            <span><i style="background:#c792ea"></i>truth</span>
            <span><i style="background:#ff5f56"></i>unreachable</span>
          </div>
        </section>
      </aside>

      <aside class="rail right">
        <section class="block grow">
          <h2>EVENT STREAM</h2>
          <ul id="c-events"></ul>
        </section>
        <section class="block">
          <h2>FINDINGS</h2>
          <ul id="c-findings"></ul>
        </section>
      </aside>

      <footer class="transport">
        <button id="c-play" class="tbtn">PAUSE</button>
        <button id="c-shot" class="tbtn on">CINEMATIC</button>
        <button id="c-speed" class="tbtn">1.0×</button>
        <div class="track">
          <div id="c-timeline"></div>
          <input id="c-scrub" type="range" min="0" max="1" value="0" step="0.001" />
          <div id="c-head"></div>
        </div>
        <div class="shotname" id="c-shotname">—</div>
      </footer>
    </div>
  `

  const q = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`) as T
  const agentsEl = q('c-agents')
  const missionEl = q('c-mission')
  const eventsEl = q<HTMLUListElement>('c-events')
  const findingsEl = q<HTMLUListElement>('c-findings')
  const minimap = q<HTMLCanvasElement>('c-minimap')
  const scrub = q<HTMLInputElement>('c-scrub')
  const timeline = q('c-timeline')
  const head = q('c-head')
  const minimapCtx = minimap.getContext('2d')!

  // -- the agent cards are built once and updated in place.
  const cards = new Map<string, { root: HTMLElement; battery: HTMLElement; state: HTMLElement }>()
  for (const [cls, meta] of Object.entries(AGENT_META)) {
    const card = el('div', 'agent')
    card.style.setProperty('--agent', meta.colour)
    const head = el('div', 'ahead')
    head.appendChild(el('span', 'aname', meta.label))
    head.appendChild(el('span', 'arole', meta.role))
    card.appendChild(head)
    const batt = el('div', 'abatt')
    const bar = el('div', 'abar')
    const fill = el('div', 'afill')
    bar.appendChild(fill)
    batt.appendChild(bar)
    batt.appendChild(el('span', 'apct', '100%'))
    card.appendChild(batt)
    const state = el('div', 'astate', '—')
    card.appendChild(state)
    agentsEl.appendChild(card)
    cards.set(cls, { root: card, battery: fill, state })
  }

  // -- the coverage history on the timeline.
  let historyBuilt = false
  let history: number[] = []

  // -- the event stream keeps the last N lines.
  let eventCursor = 0
  let lastEventText: string | null = null
  const seenTerminal = new Set<string>()
  const MAX_EVENTS = 60
  /** Events that are true once, not true every tick. */
  const TERMINAL = new Set([
    'agent.faulted',
    'agent.stranded',
    'agent.battery_critical',
    'agent.calibrated',
    'run.started',
    'run.finished',
  ])

  const room = house.rooms[0]

  function drawMinimap(frame: SimFrame): void {
    const ctx = minimapCtx
    const w = minimap.width
    const h = minimap.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#080b0f'
    ctx.fillRect(0, 0, w, h)
    if (room === undefined) return

    const pad = 10
    const sx = (w - pad * 2) / (room.aabb.maxX - room.aabb.minX)
    const sz = (h - pad * 2) / (room.aabb.maxZ - room.aabb.minZ)
    const s = Math.min(sx, sz)
    const ox = pad + ((w - pad * 2) - (room.aabb.maxX - room.aabb.minX) * s) / 2
    const oz = pad + ((h - pad * 2) - (room.aabb.maxZ - room.aabb.minZ) * s) / 2
    const px = (x: number): number => ox + (x - room.aabb.minX) * s
    const pz = (z: number): number => oz + (z - room.aabb.minZ) * s

    // The compartment outline.
    ctx.strokeStyle = '#2a3540'
    ctx.lineWidth = 1
    ctx.strokeRect(
      px(room.aabb.minX),
      pz(room.aabb.minZ),
      (room.aabb.maxX - room.aabb.minX) * s,
      (room.aabb.maxZ - room.aabb.minZ) * s,
    )

    // The coverage, as a heat field. Sampled coarsely: this is a plan view, not
    // a picture of the grid.
    const step = 2
    for (let cz = 0; cz < frame.gridHeight; cz += step) {
      for (let cx = 0; cx < frame.gridWidth; cx += step) {
        const i = cz * frame.gridWidth + cx
        if (frame.passable[i] !== 1) continue
        const count = frame.observed[i]!
        if (count < 2) continue
        const x = frame.bounds.minX + (cx + 0.5) * frame.cellSize
        const z = frame.bounds.minZ + (cz + 0.5) * frame.cellSize
        if (x < room.aabb.minX || x > room.aabb.maxX) continue
        if (z < room.aabb.minZ || z > room.aabb.maxZ) continue
        const t = Math.min(1, (count - 2) / 6)
        ctx.fillStyle = `rgba(79, 209, 197, ${0.1 + t * 0.6})`
        ctx.fillRect(px(x) - 1, pz(z) - 1, 2.5, 2.5)
      }
    }

    // The truth, which is never claimed — drawn so the viewer can see what the
    // swarm did not reach.
    for (const t of frame.truth) {
      ctx.strokeStyle = '#c792ea'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(px(t.x), pz(t.z) - 4)
      ctx.lineTo(px(t.x) + 4, pz(t.z))
      ctx.lineTo(px(t.x), pz(t.z) + 4)
      ctx.lineTo(px(t.x) - 4, pz(t.z))
      ctx.closePath()
      ctx.stroke()
    }

    // The findings.
    for (const f of frame.findings) {
      ctx.fillStyle = f.matchedAnomalyId === null ? '#8b949e' : '#f6e05e'
      ctx.fillRect(px(f.x) - 2, pz(f.z) - 2, 4, 4)
    }

    // The machines.
    for (const a of frame.agents) {
      const meta = AGENT_META[a.cls]
      ctx.fillStyle = meta?.colour ?? '#ffffff'
      ctx.beginPath()
      ctx.arc(px(a.x), pz(a.z), a.cls === 'inchworm' ? 2 : 3.2, 0, Math.PI * 2)
      ctx.fill()
      // A heading tick.
      ctx.strokeStyle = meta?.colour ?? '#ffffff'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(px(a.x), pz(a.z))
      ctx.lineTo(px(a.x) + Math.cos(a.heading) * 9, pz(a.z) + Math.sin(a.heading) * 9)
      ctx.stroke()
    }
  }

  function update(frame: SimFrame, take: Take, index: number, total: number): void {
    q('c-clock').textContent = clock(frame.simSeconds)
    q('c-tick').textContent = String(frame.tick)

    // -- the headline numbers.
    //
    // The coverage is the ROOM's, not the boat's, because that is what the
    // label says. The first version counted every passable cell in the grid and
    // printed it against "ENGINE ROOM", which was 10.1% — the whole boat — next
    // to a room that was 100% covered. A readout that mislabels its own number
    // is worse than no readout.
    const room = house.rooms[0]
    if (room !== undefined) {
      const cx0 = Math.floor((room.aabb.minX - frame.bounds.minX) / frame.cellSize)
      const cx1 = Math.floor((room.aabb.maxX - frame.bounds.minX) / frame.cellSize)
      const cz0 = Math.floor((room.aabb.minZ - frame.bounds.minZ) / frame.cellSize)
      const cz1 = Math.floor((room.aabb.maxZ - frame.bounds.minZ) / frame.cellSize)
      let free = 0
      let seen = 0
      for (let cz = Math.max(0, cz0); cz <= Math.min(frame.gridHeight - 1, cz1); cz++) {
        for (let cx = Math.max(0, cx0); cx <= Math.min(frame.gridWidth - 1, cx1); cx++) {
          const i = cz * frame.gridWidth + cx
          if (frame.passable[i] !== 1) continue
          free++
          if (frame.observed[i]! >= 2) seen++
        }
      }
      q('c-coverage').textContent = free === 0 ? '—' : `${((seen / free) * 100).toFixed(1)}%`
    }
    const matched = frame.findings.filter((f) => f.matchedAnomalyId !== null).length
    q('c-found').textContent = `${matched} / ${frame.truth.length}`
    // The faults nobody got. Not a count of "spaces the swarm cannot reach",
    // which is a different and much smaller number, and not the same thing.
    const matchedIds = new Set(
      frame.findings.map((f) => f.matchedAnomalyId).filter((id): id is string => id !== null),
    )
    q('c-miss').textContent = String(frame.truth.filter((t) => !matchedIds.has(t.id)).length)

    // -- the agent cards.
    for (const a of frame.agents) {
      const card = cards.get(a.cls)
      if (card === undefined) continue
      const pct = Math.max(0, Math.min(1, a.battery))
      card.battery.style.width = `${(pct * 100).toFixed(0)}%`
      card.battery.style.background =
        pct < 0.12 ? '#ff5f56' : pct < 0.35 ? '#ffb454' : (AGENT_META[a.cls]?.colour ?? '#4fd1c5')
      const pctEl = card.root.querySelector('.apct') as HTMLElement
      pctEl.textContent = `${(pct * 100).toFixed(0)}%`
      card.state.textContent = a.faulted
        ? 'FAULTED — BATTERY EXHAUSTED'
        : a.currentJobType !== null
          ? `${a.currentJobType.replace(/_/g, ' ').toUpperCase()}`
          : 'IDLE'
      card.state.className = a.faulted ? 'astate bad' : 'astate'
    }

    // -- the mission block.
    const mission: string[] = []
    mission.push(
      `<tr><td>compartment</td><td class="v">${room?.name ?? '—'}</td></tr>`,
      `<tr><td>agents deployed</td><td class="v">${frame.agents.length}</td></tr>`,
      `<tr><td>jobs opened</td><td class="v">${frame.jobs.length}</td></tr>`,
      `<tr><td>candidates raised</td><td class="v">${frame.findings.length}</td></tr>`,
      `<tr><td>cells examined</td><td class="v">${countObserved(frame)}</td></tr>`,
      `<tr><td>log hash</td><td class="v">${take.logHash}</td></tr>`,
    )
    missionEl.innerHTML = mission.join('')

    // -- the findings.
    findingsEl.innerHTML =
      frame.findings.length === 0
        ? '<li class="empty">no candidate raised yet</li>'
        : frame.findings
            .map(
              (f) =>
                `<li class="${f.matchedAnomalyId === null ? 'un' : 'ok'}">` +
                `<span class="fid">${f.id}</span>` +
                `<span class="fdet">${f.detectorId}</span>` +
                `<span class="fbar"><i style="width:${(f.confidence * 100).toFixed(0)}%"></i></span>` +
                `<span class="fcf">${f.confidence.toFixed(2)}</span>` +
                `</li>`,
            )
            .join('')

    // -- the event stream.
    //
    // Consecutive duplicates are ONE event. The log records what happened every
    // tick, so an agent that faults and stays faulted writes the same line
    // sixty times a second, and the stream fills with it and nothing else. The
    // stream is a narrative, and a narrative that says the same thing sixty
    // times is not saying anything.
    for (let i = eventCursor; i < index + 1 && i < take.frames.length; i++) {
      for (const e of take.frames[i]?.events ?? []) {
        const text = describeEvent(e)
        if (text === null) continue
        if (text === lastEventText) continue
        lastEventText = text
        // A terminal event happens ONCE. The log writes it every tick while it
        // is true, so "hover-01 FAULTED" appears sixty times a second and
        // every other line in the stream is about it.
        if (TERMINAL.has(e.kind)) {
          const key = `${e.kind}:${e.agentId ?? ''}`
          if (seenTerminal.has(key)) continue
          seenTerminal.add(key)
        }
        const li = el('li', `ev ${e.kind.replace(/\./g, '-')}`)
        li.appendChild(el('span', 'evt', clock(e.tick / 10)))
        li.appendChild(el('span', 'evk', text))
        eventsEl.appendChild(li)
      }
    }
    eventCursor = Math.min(index + 1, take.frames.length)
    while (eventsEl.children.length > MAX_EVENTS) eventsEl.removeChild(eventsEl.firstChild!)
    eventsEl.scrollTop = eventsEl.scrollHeight

    drawMinimap(frame)

    // -- the timeline.
    if (!historyBuilt) {
      history = buildHistory(take)
      historyBuilt = true
      timeline.innerHTML = history
        .map(
          (v, i) =>
            `<i style="left:${((i / Math.max(1, history.length - 1)) * 100).toFixed(3)}%;` +
            `height:${(v * 100).toFixed(1)}%"></i>`,
        )
        .join('')
    }
    const pct = total > 1 ? (index / (total - 1)) * 100 : 0
    head.style.left = `${pct.toFixed(3)}%`
    scrub.value = String(index)
  }

  function countObserved(frame: SimFrame): number {
    let n = 0
    for (let i = 0; i < frame.observed.length; i++) {
      if (frame.passable[i] === 1 && frame.observed[i]! >= 2) n++
    }
    return n
  }

  /**
   * The activity histogram, for the timeline.
   *
   * Not the coverage curve. The coverage of the engine room saturates in the
   * first ten seconds — the depth sensor has a three metre range, so the room is
   * mostly looked at almost immediately — and a curve that is flat for the whole
   * run is a decoration, not a readout.
   *
   * What is worth watching is the machine's *activity*: how much the swarm is
   * doing, second by second. That has shape. It has the sweep at the start,
   * the crawl down the fuel line, the long flat middle while the rover works,
   * and the end.
   */
  function buildHistory(take: Take): number[] {
    const buckets = 140
    const per = Math.max(1, Math.floor(take.frames.length / buckets))
    const out: number[] = []
    for (let b = 0; b < buckets; b++) {
      let n = 0
      const from = b * per
      const to = Math.min(take.frames.length, from + per)
      for (let i = from; i < to; i++) n += take.frames[i]?.events.length ?? 0
      out.push(n)
    }
    const max = Math.max(1, ...out)
    return out.map((v) => v / max)
  }

  return { root, update }
}
