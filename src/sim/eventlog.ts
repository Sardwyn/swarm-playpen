/**
 * Typed event log. Spec §1.5, ADR-001 §3.
 *
 * A primary structure, not a debug byproduct: it is the input to every metric in
 * spec §9. If a metric cannot name the events it consumes, it is not
 * implementable and the metric gets cut rather than approximated.
 *
 * The argument is MIL ADR-001 §1.2's: endpoint state hides trajectory, and
 * trajectory is what is diagnostic. A run ending at 71% coverage does not tell
 * you whether the agents explored efficiently and ran out of battery, or
 * thrashed on one contested region for four hundred ticks. Only the log tells
 * those apart, and they call for opposite fixes.
 *
 * Design consequences, both deliberate:
 *
 * - **Append-only.** Nothing rewrites history. A detector reads the log; it never
 *   corrects it. That keeps "the metric is a function of the evidence" true.
 * - **Fixed capacity, and hitting it is reported.** Spec §4.6 deferred RGB
 *   partly because images would make this log ~1.4 GB and force it to be sampled.
 *   A truncated evidence store makes every metric a function of what survived
 *   the truncation. So the cap exists, it is finite, and crossing it is an
 *   observable `run.truncated` condition rather than a silent degradation.
 */

import type { SimEvent, EventKind, AgentId, JobId, Manifold } from './types.ts'

/**
 * Spec §10 and ADR-001 §3. Generous for Stage A (one ground bot, 10k ticks),
 * but finite on purpose — see the class note.
 */
export const EVENT_CAP = 2_000_000

export class EventLog {
  private readonly events: SimEvent[] = []
  private truncated = false
  /** Ticks are monotonic; used to assert ordering rather than trust insertion. */
  private lastTick = -1

  push(event: SimEvent): void {
    if (this.events.length >= EVENT_CAP) {
      this.truncated = true
      return
    }
    if (event.tick < this.lastTick) {
      throw new Error(
        `EventLog: out-of-order event at tick ${event.tick} after ${this.lastTick}. ` +
          `The sim must emit in tick order.`,
      )
    }
    this.lastTick = event.tick
    this.events.push(event)
  }

  /**
   * All events of one kind, in emission order.
   *
   * Returns `SimEvent[]` rather than trying to narrow via `Extract`. `SimEvent.kind`
   * is a union of string literals on a *single* type rather than a discriminated
   * union of variants, so `Extract<SimEvent, { kind: 'x' }>` resolves to `never` and
   * every caller got an unusable signature. The narrowing that looked like it was
   * doing was silently deleting the type.
   */
  byKind(kind: EventKind): SimEvent[] {
    return this.events.filter((e) => e.kind === kind)
  }

  /** All events from one agent, in emission order. */
  byAgent(agentId: AgentId): SimEvent[] {
    return this.events.filter((e) => e.agentId === agentId)
  }

  /** All events in a tick range, inclusive of both ends. */
  inRange(fromTick: number, toTick: number): SimEvent[] {
    return this.events.filter((e) => e.tick >= fromTick && e.tick <= toTick)
  }

  /** Events matching a predicate. The general query a detector needs. */
  filter(predicate: (e: SimEvent) => boolean): SimEvent[] {
    return this.events.filter(predicate)
  }

  count(kind?: EventKind): number {
    return kind === undefined ? this.events.length : this.byKind(kind).length
  }

  all(): readonly SimEvent[] {
    return this.events
  }

  get isTruncated(): boolean {
    return this.truncated
  }

  get tickCount(): number {
    return this.events.length
  }

  /**
   * Order-sensitive hash of the whole log. This is the determinism assertion's
   * instrument: two runs with the same seed and input stream must produce
   * identical hashes at the same tick, on any machine.
   *
   * FNV-1a over a canonical byte encoding, mixing event kind, tick, ids and
   * numeric data in a FIXED key order. Key order comes from sorting, never from
   * object insertion order — spec §1.4 forbids depending on the latter.
   */
  hash(): string {
    let h = 2166136261
    const mix = (s: string): void => {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 16777619) >>> 0
      }
      h = h >>> 0
    }

    for (const e of this.events) {
      mix(e.kind)
      mix(e.tick.toString())
      mix(e.agentId ?? '')
      mix(e.jobId ?? '')
      mix(e.manifold ?? '')
      // Fixed key order.
      for (const key of Object.keys(e.data).sort()) {
        mix(key)
        const v = e.data[key]
        if (v === undefined) continue
        // Quantise to 1e-9 so the hash is stable against a ULP of noise without
        // being loose enough to hide a real divergence.
        mix((Math.round(v * 1e9) / 1e9).toString())
      }
      h ^= h >>> 15
    }

    return (h >>> 0).toString(16).padStart(8, '0')
  }
}

/** Convenience constructors. Named per kind so the data keys are checked. */

export function sensorObservation(
  tick: number,
  agentId: AgentId,
  data: { pointCount: number; confidence: number },
): SimEvent {
  return {
    tick,
    kind: 'sensor.observation',
    agentId,
    data: { pointCount: data.pointCount, confidence: data.confidence },
  }
}

export function cellObserved(
  tick: number,
  agentId: AgentId,
  manifold: Manifold,
  data: { newlyObserved: number; cumulative: number },
): SimEvent {
  return {
    tick,
    kind: 'grid.cell_observed',
    agentId,
    manifold,
    data: { newlyObserved: data.newlyObserved, cumulative: data.cumulative },
  }
}

export function agentCalibrated(
  tick: number,
  agentId: AgentId,
  data: { residualBias: number; dwellSeconds: number },
): SimEvent {
  return {
    tick,
    kind: 'agent.calibrated',
    agentId,
    data: { residualBias: data.residualBias, dwellSeconds: data.dwellSeconds },
  }
}

export function agentFaulted(
  tick: number,
  agentId: AgentId,
  data: { reason: number },
): SimEvent {
  return { tick, kind: 'agent.faulted', agentId, data }
}

export function agentStranded(tick: number, agentId: AgentId, ticksStuck: number): SimEvent {
  return { tick, kind: 'agent.stranded', agentId, data: { ticksStuck } }
}

export function jobAnnounced(
  tick: number,
  jobId: JobId,
  data: { priority: number; manifoldScore: number },
): SimEvent {
  return {
    tick,
    kind: 'job.announced',
    jobId,
    data: { priority: data.priority, manifoldScore: data.manifoldScore },
  }
}

export function bidSubmitted(
  tick: number,
  jobId: JobId,
  agentId: AgentId,
  data: { score: number; distance: number; batteryHeadroom: number },
): SimEvent {
  return {
    tick,
    kind: 'bid.submitted',
    jobId,
    agentId,
    data: {
      score: data.score,
      distance: data.distance,
      batteryHeadroom: data.batteryHeadroom,
    },
  }
}

export function jobAwarded(
  tick: number,
  jobId: JobId,
  agentId: AgentId,
  data: { winningScore: number; runnerUpScore: number },
): SimEvent {
  return {
    tick,
    kind: 'job.awarded',
    jobId,
    agentId,
    data: { winningScore: data.winningScore, runnerUpScore: data.runnerUpScore },
  }
}

export function jobDone(tick: number, jobId: JobId, agentId: AgentId, ticks: number): SimEvent {
  return { tick, kind: 'job.done', jobId, agentId, data: { ticks } }
}