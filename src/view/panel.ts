/**
 * The metrics panel. Spec §8.3.
 *
 * Every number on screen carries the detector that produced it, because a metric
 * without a provenance is a number nobody can act on — and because the panel is
 * the difference between a viewer that demonstrates the system and one that lets
 * you interrogate it.
 *
 * The honesty rules of §8.2 are visible here rather than buried: unverified
 * findings are visibly labelled, under-covered regions produce a withheld claim
 * rather than a clean bill of health, and the truth overlay is marked as a debug
 * view when it is on.
 */

import type { InspectionReport } from '../sim/report/report.ts'

export type PanelCallbacks = {
  readonly onToggle: (layer: string, on: boolean) => void
  readonly onSelect: (id: string | null) => void
  readonly onRerun: (seed: number, noise: number, jobs: boolean) => void
}

export class MetricsPanel {
  readonly root: HTMLElement

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: PanelCallbacks,
  ) {
    this.root = document.createElement('div')
    this.root.className = 'panel'
    this.container.appendChild(this.root)
  }

  render(
    report: InspectionReport,
    extras: {
      readonly seed: number
      readonly noise: number
      readonly jobs: boolean
      readonly layers: Record<string, boolean>
      readonly agentLines: readonly string[]
      readonly marketLines: readonly string[]
      readonly truthOn: boolean
    },
  ): void {
    const rows: string[] = []

    rows.push('<h2>Metrics</h2>')
    rows.push(
      `<p class="sub">seed ${extras.seed} · noise ${extras.noise} · jobs ${extras.jobs ? 'on' : 'OFF (baseline)'} · ${report.findings.length} findings</p>`,
    )

    // --- coverage -----------------------------------------------------------
    rows.push('<h3>spec §9.1 — coverage</h3><table>')
    for (const c of report.coverage) {
      rows.push(
        `<tr><td>${c.manifold}</td><td>${(c.fraction * 100).toFixed(2)}%</td>` +
          `<td class="det">grid.coverage</td></tr>`,
      )
    }
    rows.push('</table>')

    // --- agents -------------------------------------------------------------
    rows.push('<h3>agents</h3><table>')
    for (const line of extras.agentLines) rows.push(`<tr><td colspan="3">${line}</td></tr>`)
    rows.push('</table>')

    // --- market -------------------------------------------------------------
    if (extras.marketLines.length > 0) {
      rows.push('<h3>spec §9.4 — job market</h3><table>')
      for (const line of extras.marketLines) {
        rows.push(`<tr><td colspan="3">${line}</td></tr>`)
      }
      rows.push('</table>')
    }

    // --- per-class ----------------------------------------------------------
    rows.push('<h3>spec §9.2 — per-class detection</h3><table>')
    rows.push('<tr><th>class</th><th>P / R / F1</th><th>loc / IoU</th></tr>')
    for (const m of report.metrics.byClass) {
      if (m.notAssessable) {
        rows.push(
          `<tr class="muted"><td>${m.cls}</td><td colspan="2">NOT ASSESSABLE — ${escape(m.notAssessableReason ?? '')}</td></tr>`,
        )
        continue
      }
      const loc = m.meanLocalisationError === null ? '—' : `${m.meanLocalisationError.toFixed(2)} m`
      const iou = m.meanExtentIou === null ? '—' : m.meanExtentIou.toFixed(2)
      rows.push(
        `<tr><td>${m.cls}</td><td>${m.precision.toFixed(2)} / ${m.recall.toFixed(2)} / ${m.f1.toFixed(2)}</td>` +
          `<td>${loc} / ${iou}</td></tr>`,
      )
    }
    rows.push('</table>')

    // --- findings -----------------------------------------------------------
    rows.push('<h3>findings — click to focus</h3><table class="findings">')
    for (const f of report.findings) {
      const cls = f.status === 'confirmed' ? 'ok' : 'warn'
      const loc = f.localisationError === null ? 'unmatched' : `${f.localisationError.toFixed(2)} m`
      rows.push(
        `<tr class="${cls}" data-id="${f.id}">` +
          `<td>${f.status === 'confirmed' ? 'CONFIRMED' : 'UNVERIFIED'}</td>` +
          `<td>${f.class}</td><td>${f.confidence.toFixed(2)}</td>` +
          `<td class="det">${f.detectorId}</td><td>${loc}</td></tr>`,
      )
    }
    if (report.findings.length === 0) rows.push('<tr class="muted"><td colspan="5">none</td></tr>')
    rows.push('</table>')

    // --- withheld claims ----------------------------------------------------
    rows.push('<h3>spec §8.2 rule 2 — withheld claims</h3>')
    if (report.withheldClaims.length === 0) {
      rows.push('<p class="ok">every region met the coverage threshold</p>')
    } else {
      rows.push('<ul class="muted">')
      for (const w of report.withheldClaims) rows.push(`<li>${escape(w)}</li>`)
      rows.push('</ul>')
    }

    // --- layers -------------------------------------------------------------
    rows.push('<h3>layers</h3><div class="toggles">')
    for (const [name, on] of Object.entries(extras.layers)) {
      rows.push(
        `<label><input type="checkbox" data-layer="${name}" ${on ? 'checked' : ''} /> ${name}</label>`,
      )
    }
    rows.push('</div>')

    if (extras.truthOn) {
      rows.push(
        '<p class="warn"><strong>TRUTH OVERLAY ON.</strong> These are the authored anomalies. ' +
          'Nothing in the report or the metrics may use them; the run cannot see them. ' +
          'This view exists to check the detectors, not to help them.</p>',
      )
    }

    rows.push(
      '<h3>rerun</h3><div class="rerun">' +
        '<label>seed <input id="seed" type="number" value="' +
        extras.seed +
        '" /></label>' +
        '<label>noise <input id="noise" type="number" step="0.5" value="' +
        extras.noise +
        '" /></label>' +
        '<label><input id="jobs" type="checkbox" ' +
        (extras.jobs ? 'checked' : '') +
        ' /> jobs</label>' +
        '<button id="rerun">run</button></div>',
    )

    rows.push(
      '<p class="sub">orbit: drag + wheel · fly: Tab, then WASD/QE + arrows</p>',
    )

    this.root.innerHTML = rows.join('')

    this.root.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((el) => {
      el.addEventListener('change', () => {
        this.callbacks.onToggle(el.dataset.layer!, el.checked)
      })
    })

    this.root.querySelectorAll<HTMLElement>('tr[data-id]').forEach((el) => {
      el.addEventListener('click', () => this.callbacks.onSelect(el.dataset.id!))
    })

    this.root.querySelector<HTMLButtonElement>('#rerun')?.addEventListener('click', () => {
      const seed = Number(this.root.querySelector<HTMLInputElement>('#seed')?.value ?? '1')
      const noise = Number(this.root.querySelector<HTMLInputElement>('#noise')?.value ?? '1')
      const jobs = this.root.querySelector<HTMLInputElement>('#jobs')?.checked ?? true
      this.callbacks.onRerun(seed, noise, jobs)
    })
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}