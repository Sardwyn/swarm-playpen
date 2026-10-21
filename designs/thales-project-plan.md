# Thales challenge — nine-month project plan

**Work package:** Digital Twin Industry Challenge Led Accelerator 2026, Thales challenge
**Duration:** nine months, Feb 2027 – Oct 2027 (kick-off in person, UK Digital Twin Centre, Belfast; showcase Oct 2027)
**Budget:** up to £75,000 (see `designs/thales-application.md`, Criterion 3)
**Status:** draft, not submitted

---

## 0. The shape of the work in one paragraph

The prototype is split into a **harness** (domain-agnostic, carries the trust) and a
**domain** (environment, sensors, agents, fault taxonomy, detection rules). The
project is: prove the transfer of the harness to a vessel domain, rebuild the domain
content with Thales, and produce a measured validation record. There is no step in
which we build a digital twin "for" a vessel and hope it validates; the ground truth
is authored from the start, so validation is a byproduct rather than a task.

---

## 1. What transfers unchanged, what is rebuilt, what is new

### 1.1 Unchanged — the harness core (≈110 KB, all of the trust)

| Module | File | Why it transfers |
|---|---|---|
| Typed event log | `src/sim/eventlog.ts` | The provenance spine. Every metric must name the events it consumes, or be cut. Domain-agnostic by construction. |
| Determinism substrate | `src/sim/math.ts`, `src/sim/rng.ts` | IEEE-754 restriction to `+ - * /` and `sqrt`; fixed iteration counts; seeded PRNG; injected tick counter; no wall clock, no `Math.random`. Guarantees a metric regression always has a cause. |
| Evidence pack | `src/sim/report/{frame,metrics,report}.ts` | Mandatory coverage, withheld claims, byte-identical JSON. This is the deliverable Thales would consume. |
| Sensor noise model | `src/sim/sensors/noise.ts` | Reusable; maritime noise characteristics differ only in parameters. |
| Job schema | `src/sim/jobs/schema.ts` | Typed job contracts. Reusable. |
| Viewer | `src/view/*` | Reads sim frames, writes nothing. Reusable verbatim; it is the demonstrator's face. |
| Boundary + determinism tests | `test/boundary/*`, `test/determinism/*` | Parameterised by adapter; become the shared acceptance suite for any future domain. |

### 1.2 Rebuilt for the maritime domain

| Prototype | Maritime replacement |
|---|---|
| Rooms, doors, walls (`world/geometry.ts`) | Vessel compartments, hatches, bulkheads, deck |
| Conduits and ports (`world/lumen.ts`, `world/bore.ts`) | Bilge, hull voids, cable ducts, pipe runs, tanks; access points = hatches and inspection ports |
| Attic / ceiling void (`world/volumetric.ts`) | Machinery space, sensor mast, above-deck canopy |
| Ground bot, inchworm, hover bot | Deck crawler, confined-space crawler, above-deck drone |
| Depth, thermal, humidity, air/VOC, IMU | Same physics, maritime parameters; plus fuel/battery state and vibration if Thales supplies them |
| 21 building anomalies (`content/anomalies-01.json`) | Maritime fault taxonomy — water ingress, corrosion, structural cracking, blocked ventilation, fuel/VOC release, battery degradation |
| Detector rules (`sim/detectors.ts`) | Rebuilt per fault class, per manifold, with the same detector protocol |

### 1.3 New work

- Distributed timing across vessels and sensors (time drift / synchronicity is a named
  Thales SME requirement and we do not currently have it).
- Standards-aligned output: STANAG, ISO 23247, and an interoperability path.
- The maritime fault taxonomy, authored jointly with Thales.
- A fidelity argument for the sensor models, and the plan to compare against hardware logs.

---

## 2. Phases and gates

Each phase ends in a gate. A gate that fails is reported, not worked around. A gate
that cannot be met in month 2 is a stop, and we would rather stop than persist — the
programme's own logic is that a validated negative result is worth more to Thales than
an unvalidated positive one.

### Phase 1 — Domain transfer (months 1–2)

**Work packages**
1.1 Define the maritime manifold model: compartment graph, constrained volumes, access
     points. Deliverable: `vessel-01.json` + a written manifold rationale, compared
     side by side with the building's three manifolds.
1.2 Port the world model: geometry, lumen graph, bore/conduit traversal, volumetric
     occupancy. Deliverable: a navigable vessel with at least four disconnected
     constrained components (we learned in the building that disconnected components
     are the interesting case, not a bug).
1.3 Re-point the sensors: same physics, maritime parameters, and the manifest of what
     each sensor can and cannot observe.
1.4 Parameterise the boundary and determinism tests against the maritime adapter.
     Deliverable: the shared acceptance suite running green on the vessel domain.
1.5 Re-plan the viewer for a vessel scene.

**Gate 1** — *Thales review.* The manifold model, the sensor manifest and the
constrained-volume graph are put in front of Thales. The question we are asking is
narrow: **are the constrained volumes the ones that matter on a USV?**
Pass = Thales agrees the model, or names the two volumes we got wrong.
Fail = we re-model. **Month-2 stop decision** if the model's premise does not survive.

### Phase 2 — Maritime fault taxonomy (months 2–4)

**Work packages**
2.1 Workshop with Thales to define the fault taxonomy: classes, observables, the
     manifold each is detectable from, and — the part that matters — **which faults
     have no second observable**. That last column is the direct application of our
     0% finding: we are asking Thales to mark, per fault class, whether corroboration
     is physically possible on a USV. Deliverable: the taxonomy, with a
     corroboration-possibility column.
2.2 Build the authored ground truth for each fault class. Deliverable:
     `anomalies-vessel-01.json`, generated so that every fault class has a known
     placement, and so that each fault's second-observability status is explicit.
2.3 Write the detection rules per fault class, per manifold, with detector IDs and
     the reason any deliberately-silent detector is silent.
2.4 Extend the no-silent-detector guard to the vessel domain, including the
     declaration each detector needs (the lesson from the prototype: a detector may
     not be quietly added to a silent allow-list).

**Gate 2** — *The corroboration table.* We produce a table, per fault class: can it be
detected? can it be corroborated? by what? and if not, why not. Thales' engineering
judgement is the acceptance test. This is the artefact that turns our 0% from an
observation about one building into a claim about the maritime domain.

### Phase 3 — Vessel twin demonstrator with viewer (months 4–6)

**Work packages**
3.1 Agent set: deck crawler, confined-space crawler, above-deck drone, with the
     capability model and the escalation logic. The prototype's finding — that
     escalation fails at 0% because the fault has no second observable — is the design
     input: in the vessel domain we *choose* sensor pairings that give each fault
     class a second observable where one physically exists.
3.2 Job system and coverage policy, unchanged in mechanism.
3.3 Viewer: vessel scene, orbit and fly cameras, layer toggles, clickable findings,
     every metric carrying its detector ID, withheld claims rendered. Deliverable: the
     demonstrator Thales can actually use in a review meeting.
3.4 Energy model: the deck crawler's power budget, and the endurance-vs-altitude
     result as a calibration of what "reachable" costs.

**Gate 3** — *Coverage.* A measured coverage number for the vessel's accessible
volume by the three-agent set, with the skipped regions and reasons stated. Not a
claim of full coverage; a stated number.

### Phase 4 — Validation campaign (months 6–8)

**Work packages**
4.1 Corpus runs across seeds, noise levels and mission durations. Deliverable: the
     detection and corroboration matrix — per fault class, per manifold: recall,
     precision, corroboration rate.
4.2 The trajectory-dependence correction. The prototype established that *detection
     recall is a function of trajectory, so a per-class recall number is a property of
     the detector **and** the policy*. All reported recall must therefore be
     conditioned on the policy, and the conditioning stated. A per-class recall number
     reported without it is a wrong number, not an imprecise one.
4.3 Coverage-calibrated confidence. Confidence is coverage-multiplied, not averaged.
     One pass over a space is a glimpse and does not pass; that calibration carries
     over and is re-derived for the vessel.
4.4 Sensitivity and ablation: which detectors, sensors or policies move the numbers,
     and which do nothing. Deliverable: the ablation table.

**Gate 4** — *The measured record.* A single document: per fault class, what was
detected, what was corroborated, what was skipped and why, with byte-identical
replay from a seed for every number. This is the deliverable Thales keeps.

### Phase 5 — Standards, report, showcase (months 8–9)

**Work packages**
5.1 Standards alignment: STANAG-aligned output for the fault and health records;
     ISO 23247 framing for the twin; an interoperability path so the evidence pack
     is consumable by systems we have not met.
5.2 Time-drift and synchronicity work: distributed timing across vessels and sensors.
5.3 Final report: method, transfer evidence, measured record, honest limitations —
     including the fidelity caveat, which stands until hardware comparison exists.
5.4 IP: provisional patent filings on the capability-limited corroboration model and
     the coverage-multiplied confidence calibration, following the Phase 3 search.
5.5 Showcase: the demonstrator, the record, and the commercial ask.

**Gate 5** — Showcase. The programme ends; the relationship does not.

---

## 3. Dependency map — what blocks what

```
Phase 1  manifold model ──┬──> Phase 2  fault taxonomy ──┬──> Phase 3  demonstrator
                          │                               │
                          └──> Phase 4  validation <───────┘
                                   │
                                   └──> Phase 5  standards + report
```

Critical path: **Phase 1 → Phase 2**. Everything downstream is blocked by the
taxonomy, because the taxonomy defines the ground truth, the detectors, the
corroboration question and the acceptance criteria simultaneously. If Phase 1
consumes more than two months, the taxonomy compresses and the campaign suffers.
That is why Phase 1 has a stop decision rather than a slip allowance.

---

## 4. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner | Trigger for the response |
|---|---|---|---|---|---|---|
| R1 | Sensor fidelity: synthetic models do not match a real hull | High | High | Every output states the upper-bound caveat; hardware comparison is a Phase 4 deliverable, not a claim | Applicant | Detected Phase 4 |
| R2 | Transfer invalid: the manifold model is wrong for vessels | Medium | High | Thales review at Gate 1; month-2 stop decision | Thales + applicant | Gate 1 |
| R3 | Some fault classes have no physically possible corroboration | **High** | Medium | This is a *finding*, not a failure — it is the Phase 2 deliverable, and the Phase 4 table states it per class | Applicant | Expected in Phase 2 |
| R4 | Standards mapping slips | Medium | Medium | Designed in from month 1, not retrofitted; standards consultant contracted in Phase 2 | Applicant | Phase 3 slip |
| R5 | Key-person concentration | Medium | High | Every module carries a written spec and a test; second engineer contracted for Phases 3–5 | Applicant | Resignation risk |
| R6 | Funding milestone slip | Low | High | 10% contingency; two budget lines fall downward if Thales supplies domain input | Applicant | Phase 2 budget review |
| R7 | Nine months competing with other commitments | **High** | High | Scope is fixed at one vessel class; the core is already written and tested; second engineer covers Phases 3–5 | Applicant | Phase 1 slip |
| R8 | Corporate due diligence fails post-award | Low | High | Company incorporated and bank account open before application; accounts prepared on award | Applicant | Pre-award |

---

## 5. What we must not do

- **Do not claim full coverage.** The prototype's own ceiling-raster calibration says
  a single pass scores 0.578 and does not pass a 0.6 gate. Coverage is a stated number
  with stated exclusions, never a summary adjective.
- **Do not report per-class recall without conditioning it on the policy.** That is a
  wrong number, not an imprecise one.
- **Do not let a detector return nothing silently.** Every detector either fires over
  the control scenario or is declared silent with a reason, and the declaration is
  itself asserted.
- **Do not present a partial run as a clean one.**
- **Do not claim the maritime taxonomy as ours if it is authored with Thales.**
- **Do not exceed month 2 in Phase 1.** Stop and report.

---

## 6. Milestones and cash

The programme cascades funding against milestones. Proposed gates, mapped to the
phases above:

| Month | Milestone | Gate | Draw |
|---|---|---|---|
| 2 | Manifold model reviewed and accepted by Thales | Gate 1 | 15% |
| 4 | Fault taxonomy and corroboration table | Gate 2 | 20% |
| 6 | Vessel demonstrator with viewer | Gate 3 | 25% |
| 8 | Validation campaign and measured record | Gate 4 | 25% |
| 9 | Standards-aligned report, showcase | Gate 5 | 15% |

---

## 7. If this works

The maritime fault taxonomy and the corroboration table are the transferable assets.
The harness is the method. The measured record is the proof.

The same instrument, rebuilt for a different domain, is a different product. That is
the growth argument in Criterion 4 — and it is also why the harness core must stay
domain-agnostic even when only one domain is paying for it.
