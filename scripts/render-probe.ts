/**
 * A headless render probe.
 *
 * ## Why
 *
 * The 3-D view cannot be looked at from inside the authoring tool: the desktop
 * app this runs in will not give us a WebGL context. So the scene is built
 * blind, which is exactly how it ends up wrong.
 *
 * This script drives a real Chrome with software GL, renders the demo, and
 * reduces the frame to a **text map** that can be read in a terminal: a grid of
 * characters, one per cell, coloured by what is actually on screen. It also
 * prints the screen-space position of every machine and a luminance histogram,
 * which is the part that can be checked numerically.
 *
 * It is not a substitute for looking at it. It is the difference between
 * checking the geometry and guessing at it.
 *
 * ## Usage
 *
 *     node scripts/render-probe.mjs [t0 t1 t2 ...]      # playhead fractions
 *
 * Writes `.shots/probe-<t>.txt` and prints them.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL_BASE = process.env.PROBE_URL ?? 'http://127.0.0.1:4173/index-yacht.html'
const OUT = 'F:/Lab/swarm/swarm/.shots'
const PORT = 9333

const TIMES = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n))
const PLAYHEADS = TIMES.length > 0 ? TIMES : [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]

mkdirSync(OUT, { recursive: true })

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--window-size=1024,576',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=F:/Lab/swarm/swarm/.shots/chrome-profile',
    URL_BASE,
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
)

const log = (msg: string): void => {
  process.stderr.write(`[probe] ${msg}\n`)
}

/** Wait for the debugging endpoint to answer. */
async function endpoint(): Promise<string> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = (await res.json()) as { type: string; webSocketDebuggerUrl: string }[]
      const page = list.find((t) => t.type === 'page')
      if (page !== undefined) {
        log(`debugger up, page ${page.webSocketDebuggerUrl}`)
        return page.webSocketDebuggerUrl
      }
    } catch (err) {
      if (i % 8 === 0) log(`waiting for debugger: ${String(err).slice(0, 80)}`)
    }
    await sleep(250)
  }
  throw new Error('chrome did not open a debugging port')
}

/** A minimal CDP client. Node 22 has a WebSocket in the global scope. */
class Cdp {
  private readonly socket: WebSocket
  private next = 1
  private readonly pending = new Map<number, (v: unknown) => void>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as { id: number; result?: unknown }
      const resolve = this.pending.get(msg.id)
      if (resolve !== undefined) {
        this.pending.delete(msg.id)
        resolve(msg.result)
      }
    })
  }

  static async open(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new Cdp(socket)
  }

  send(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.next++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval<T>(expression: string): Promise<T> {
    const res = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text: string } }
    if (res.exceptionDetails !== undefined) {
      throw new Error(res.exceptionDetails.text)
    }
    return res.result?.value as T
  }

  /** Evaluate, but do not hang the whole probe if the page wedges. */
  async evalWithTimeout<T>(expression: string, timeoutMs = 20000): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.eval<T>(expression),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error('eval timed out')), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  close(): void {
    this.socket.close()
  }
}

/**
 * The page-side probe.
 *
 * It renders the live canvas into a small 2-D canvas and reduces it to text.
 * The 3-D canvas keeps its drawing buffer (`preserveDrawingBuffer`), so it can
 * be read after a render.
 */
const SNAPSHOT = `
(() => {
  const w = 96, h = 40;
  const data = window.__yacht.snapshot(w, h);
  if (!data || data.length === 0) return { error: 'no canvas' };

  // Character buckets: by hue first, then by luminance.
  function glyph(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const v = max / 255;
    const s = max === 0 ? 0 : (max - min) / max;
    if (v < 0.08) return ' ';
    if (s < 0.16) {
      if (v < 0.25) return '.';
      if (v < 0.45) return ':';
      if (v < 0.68) return '*';
      return '#';
    }
    let h;
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h = ((h * 60) + 360) % 360;
    if (h >= 190 && h < 250) return v > 0.55 ? 'C' : 'c';   // cyan / teal
    if (h >= 90 && h < 190) return v > 0.55 ? 'G' : 'g';    // green
    if (h >= 40 && h < 90) return v > 0.5 ? 'Y' : 'y';     // yellow / amber
    if (h < 40 || h >= 330) return v > 0.5 ? 'R' : 'r';    // red / magenta
    return v > 0.5 ? 'O' : 'o';                            // orange
  }

  const rows = [];
  let lumSum = 0, lit = 0;
  const hist = { dark: 0, dim: 0, mid: 0, bright: 0 };
  // A census of the colours actually on screen. The text map says what hue
  // fills the frame; the census says which surface it is.
  const census = new Map();
  for (let y = 0; y < h; y++) {
    let line = '';
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const l = (0.2126*r + 0.7152*g + 0.0722*b) / 255;
      lumSum += l;
      if (l > 0.12) lit++;
      if (l < 0.12) hist.dark++; else if (l < 0.35) hist.dim++;
      else if (l < 0.62) hist.mid++; else hist.bright++;
      const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
      census.set(key, (census.get(key) ?? 0) + 1);
      line += glyph(r, g, b);
    }
    rows.push(line);
  }
  const palette = [...census.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, n]) => {
      const [r, g, b] = key.split(',').map(Number);
      const hex = '#' + [r, g, b].map((v) => (v * 16).toString(16).padStart(2, '0')).join('');
      return { hex, count: n, share: +(n / (w * h)).toFixed(3) };
    });

  // Where each machine is, in screen space, and how big it is.
  const agents = [];
  const yac = window.__yacht;
  if (yac && yac.frame && yac.project) {
    for (const a of yac.frame.agents) {
      const p = yac.project(a.x, a.y + 0.15, a.z);
      agents.push({
        id: a.id,
        sx: +p.sx.toFixed(1),
        sy: +p.sy.toFixed(1),
        behind: p.behind,
        x: +a.x.toFixed(2), y: +a.y.toFixed(2), z: +a.z.toFixed(2),
        job: a.currentJobType,
        battery: +(a.battery * 100).toFixed(0),
        faulted: a.faulted,
      });
    }
  }

  return {
    map: rows.join('\\n'),
    meanLuminance: +(lumSum / (w*h)).toFixed(4),
    litFraction: +(lit / (w*h)).toFixed(4),
    histogram: hist,
    palette,
    agents,
  };
})()
`

type ProbeOut = {
  error?: string
  map: string
  meanLuminance: number
  litFraction: number
  histogram: Record<string, number>
  palette: { hex: string; count: number; share: number }[]
  agents: unknown[]
  canvasSize: number[]
}

async function main(): Promise<void> {
  const url = await endpoint()
  const cdp = await Cdp.open(url)
  await cdp.send('Runtime.enable')

  // Wait for the run to finish and the scene to exist.
  let ready = false
  for (let i = 0; i < 240; i++) {
    const state = await cdp.evalWithTimeout<{ take: unknown; scene: unknown }>(
      '({ take: !!(window.__yacht && window.__yacht.take), scene: !!(window.__yacht && window.__yacht.scene) })',
    )
    if (state.take && state.scene) {
      ready = true
      log('the run finished')
      break
    }
    if (i % 10 === 0) log(`waiting for the run: ${JSON.stringify(state)}`)
    await sleep(500)
  }
  if (!ready) {
    console.error('the page never reported a finished run')
    cdp.close()
    chrome.kill()
    process.exit(1)
  }

  // Stop the playhead moving while we look at a frame, and stop the render
  // loop drawing: with software GL a continuous bloom pass starves the thread.
  await cdp.evalWithTimeout('window.__yacht.pause && window.__yacht.pause()')
  await cdp.evalWithTimeout('window.__yacht.freeze && window.__yacht.freeze(true)')

  const report: string[] = []
  for (const t of PLAYHEADS) {
    log(`rendering t=${t.toFixed(2)}`)
    await cdp.evalWithTimeout(`window.__yacht.showAt(${t} * (window.__yacht.take.frames.length - 1))`)
    const out = await cdp.evalWithTimeout<ProbeOut>(SNAPSHOT, 40000)
    if (out === undefined || out.error !== undefined) {
      log(`probe error: ${out?.error ?? 'no result'}`)
      continue
    }
    report.push(`=== t = ${t.toFixed(2)} ===`)
    report.push(String(out.map))
    report.push(
      `meanLuminance=${out.meanLuminance} litFraction=${out.litFraction} hist=${JSON.stringify(out.histogram)}`,
    )
    report.push(`palette=${out.palette.map((p) => `${p.hex}:${p.share}`).join(' ')}`)
    report.push(`agents=${JSON.stringify(out.agents)}`)
    const shot = await cdp.evalWithTimeout<unknown>('window.__yacht.shotState()')
    report.push(`shot=${JSON.stringify(shot)}`)
    const rays = await cdp.evalWithTimeout<unknown[]>('window.__yacht.probeRays()')
    report.push(`rays=${JSON.stringify(rays)}`)
    report.push('')
    writeFileSync(`${OUT}/probe-${t.toFixed(2)}.txt`, report.join('\n'))
  }
  console.log(report.join('\n'))
  cdp.close()
  chrome.kill()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  chrome.kill()
  process.exit(1)
})
