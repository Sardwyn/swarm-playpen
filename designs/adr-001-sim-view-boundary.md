# ADR-001 — Sim/view boundary and the determinism guarantee

**Status:** accepted
**Date:** 2026-10-01
**Input:** a decision about how the inspection playpen is structured — what lives
in the simulation core, what lives in the viewer, and what the project promises
about reproducibility.
**Supersedes:** nothing.
**Amends:** `swarm-simulation-spec.md` §1.2, §1.4, §1.5 (these sections are the
decision; this is the reasoning and the consequences).

---

## 1. Context

Three requirements pull against each other and cannot all be satisfied naively:

1. **Headless runs.** Metrics must come from thousands of runs, so the simulation
   must execute without a display, fast, in a test runner.
2. **Visual interrogation.** The system must be inspectable in a browser, which
   means a real 3-D renderer with a scene graph.
3. **Determinism.** A metric regression must have a cause. A run must replay
   exactly.

Requirement 2 is the tempting one: it is the most fun to build, and it is the one
that quietly destroys the other two.

---

## 2. Decision

> **The simulation core is plain TypeScript with no renderer types in its import
> graph. The viewer reads simulation frames and never writes simulation state.
> All state changes go through commands.**

Enforced by `test/boundary/no-render-imports.test.ts`, which walks the import
graph of `src/sim/` and fails if `three` appears at any depth. Not lint, not
convention — a failing test.

And, extending it:

> **The sim core uses only `+ - * /` and `Math.sqrt`.**

### 2.1 Why the import boundary is a test and not a rule

The failure mode is not someone ignoring the rule. It is someone adding
`import { Vector3 } from 'three'` to make a pose calculation one line shorter,
which works, which passes review because it is one line, and which then couples
the simulation to a rendering library's coordinate conventions, matrix layout and
version. The next person to change the renderer changes the simulation.

A test is the only enforcement that survives contact with a deadline. This is the
same reasoning as MIL ADR-001 §2: **the model may interpret, the engine decides —
and the boundary has to be mechanical, because a boundary that depends on
discipline is not a boundary.**

### 2.2 Why the viewer may read but not write

The viewer is a consumer. It holds no authoritative state, persists nothing, and
its undo is "reload the frame". This means:

- a viewer crash costs a frame, not a run;
- the headless and browser paths execute **identical** simulation code, so a bug
  reproduced in the browser is a bug in the tests, not a rendering artefact;
- the viewer can be replaced entirely — Three.js, a terminal plotter, a
  WebGL-free debugging view — without touching a line of simulation.

The cost is that the viewer cannot do things like "let me drag this agent here to
debug the allocator". That is a real ergonomic loss and it is accepted. The
substitute is **injected commands**: the viewer can request the same
"inject a fault at tick N" that the tests use, so interactive debugging goes
through the sanctioned path and stays reproducible. Debugging that bypasses the
boundary is debugging that lies to you.

### 2.3 The transcendental restriction

This is the part that is specific to JavaScript and would not have been written
for a C# core.

**IEEE-754 specifies `+ - * /` and `sqrt` exactly.** Every conforming
implementation returns bit-identical results. ECMAScript specifies `Math.sin`,
`Math.cos`, `Math.exp`, `Math.log` and `Math.pow` only as *approximately*
specified — the last bits are implementation-defined, and V8, SpiderMonkey and
JavaScriptCore may each differ.

So a single `Math.sin` in a heading update produces this:

- same machine, same engine → bit-identical forever. **Local tests all pass.**
- different machine, different engine → divergent drift.
- CI on Linux vs. your laptop on Windows → irreproducible metrics.

And it diverges *silently and increasingly*, because the error compounds through
the pose graph. The run looks fine. The coverage number is 2% off and nobody can
say why.

**Therefore:** angles use a bounded rational approximation; exponentials and
logarithms in the diffusion and noise models use bounded series expansions.
Iteration counts are fixed constants, never tolerance-driven, for the same
reason. Enforced by `test/determinism/transcendental.test.ts`, which greps `sim/`
for the banned identifiers.

**Iteration counts are fixed rather than tolerance-driven** deserves its own
sentence, because it is the same trap in a different disguise. "Iterate until
convergence" is not deterministic even in IEEE-exact arithmetic: the iteration
count becomes a function of the data, so an innocuous change to the house
geometry changes the number of Gauss-Newton iterations, which changes the
floating-point result. Fixed 6 iterations, always. Slightly less accurate, and
reproducible, which is the trade the whole project rests on.

### 2.4 Seeded PRNG, and no clock

`mulberry32`, seeded per run, recorded in every report. `Math.random()` is banned
in `sim/` — it is unseedable, so it silently makes every run unique and every
comparison meaningless.

No `Date.now()` in `sim/`. Time is an injected tick counter. A simulation that
reads the wall clock cannot be replayed, cannot be fast-forwarded, and cannot be
compared.

---

## 3. The typed event log is a primary structure

> The event log is the input to the metrics. No metric may be computed from final
> state alone.

Adopted from MIL ADR-001 §1.2, because the argument is identical and already
proven in this repo: **endpoint state hides trajectory, and trajectory is what is
diagnostic.** A run that ends with 71% coverage does not tell you whether the
agents explored efficiently and ran out of battery, or thrashed on one contested
region for four hundred ticks. Only the log distinguishes those, and they call
for opposite fixes.

Consequences:

- Every metric in spec §9 names the events it consumes. If a metric cannot name
  them, it is not implementable and the metric is cut rather than approximated.
- Prose may only phrase detector claims and must cite the detector ID.
- **The log's size is a design constraint, not an operational detail.** This is
  the lesson from MIL's 20,000-event cap, and it is why RGB is deferred with
  costs stated (spec §4.6): images would make the log ~1.4 GB and turn the
  evidence store into the thing that needs truncating. A truncated evidence store
  makes every metric a function of what survived the truncation.

---

## 4. Alternatives considered

| Option | Rejected because |
| --- | --- |
| Put the sim inside the engine (Godot/Unity nodes) | Headless runs become a build-mode flag; determinism depends on engine internals; the §S8 thousand-run sweep becomes a manual campaign |
| Three.js throughout, no boundary | Simplest to write, and it makes rendering bugs into simulation bugs. The version of this that works by luck stops working at the first engine upgrade |
| Rust/WASM core for speed | Overkill. The tick budget has ~20× headroom (§9.6). Optimising the wrong layer |
| Fixed-point arithmetic for determinism | Would work, and it costs every float in the SLAM code for a guarantee that the transcendental restriction plus fixed iteration counts already provides |
| Deterministic only within one machine | Cheapest. But "works on my machine" is the failure this project exists to avoid — it is a test harness |

---

## 5. Consequences

**Good:**

- A 2,000-tick soak is `npm test`, so scenarios run in CI and metrics cannot rot.
- A bug report is "seed 4,208, tick 1,340" and it replays.
- The viewer is replaceable, and the headless path is provably the same code.
- Metric regressions have causes, because the log holds the trajectory.

**Bad, accepted:**

- Interactive debugging is slightly harder (§2.2) — mitigated by injected
  commands, not eliminated.
- Fixed iteration counts are marginally less accurate than tolerance-driven
  convergence. We trade a small accuracy loss for reproducibility, deliberately.
- Rational approximations for `sin`/`exp` are less pleasant to write than the
  built-ins, and they must be tested against the built-ins for accuracy on the
  domain actually used (`test/math/approximations.test.ts`).
- The transcendental restriction will be violated by accident at least once. The
  grep test exists because of this.

**Neutral:**

- Language choice was settled by what is already installed in this repo, not by
  merit. Recorded so nobody relitigates it as a technical question.

---

## 6. What this ADR does not settle

- Whether the SLAM simplifications (scan-matching correlation instead of real
  ICP; graph-relational inchworm localisation) are faithful enough to the real
  hardware. That is a fidelity question, and it is settled by comparing against
  hardware logs, not by argument. **Until that comparison exists, spec §13's
  claim that all accuracy numbers are upper bounds stands unchallenged.**
- Whether 4.1 ms/tick is achievable in practice. Spec §9.6 measures it; this ADR
  only requires that it be measured.