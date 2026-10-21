# Thales challenge — application draft

**Programme:** Digital Twin Industry Challenge Led Accelerator 2026 (Digital Catapult / UK Digital Twin Centre, Innovate UK funded)
**Challenge:** Thales — *Health monitoring of uncrewed vessels*
**Deadline:** 23:59, 27 October 2026. One challenge only.
**Funding:** up to £75,000 cash + up to £14,000 specialist support, nine months, milestone-cascaded.
**Scoring:** four criteria, 25% each. Structure below follows the FAQ's exact sub-bullets.

Status: draft, not submitted. Facts asserted here are traceable to
`designs/swarm-simulation-spec.md`, `designs/adr-001-sim-view-boundary.md`, the test
suite, and the Thales challenge brief V2.

---

## Evidence base — what we can actually assert

| Claim | Source | Verified |
|---|---|---|
| 425 tests, 20 files, all passing | `npm test` | 21 Oct 2026 |
| Typecheck clean | `npm run typecheck` | 21 Oct 2026 |
| Determinism: only `+ - * /` and `sqrt`; fixed iteration counts; seeded PRNG; injected tick counter; no wall clock; no `Math.random` | ADR-001 §2.3–2.4 | by test |
| Simulator core has no renderer types in its import graph | ADR-001 §2; `test/boundary/no-render-imports.test.ts` | by test |
| Ground truth is unreachable by any sensor or detector | `test/boundary/no-ground-truth-leak.test.ts` — *"the single highest-value test in the suite"* | by test |
| Every detector must emit at least one candidate, or be declared silent **with a reason** | `test/boundary/no-silent-detector.test.ts` | by test |
| Coverage is multiplied into confidence, not averaged | spec §9.1, §11.31 | by test |
| Browser and headless produce identical tick counts, job tallies, coverage and per-class metrics | `test/determinism/rng-and-replay.test.ts` (parity block) | by test |
| Corroboration from the constrained manifold succeeds in **0%** of cases | spec §11 (Stage E part three) — *"THE KILL CONDITION FIRED"*… the corroboration logic | by test |

**The 0% is the whole application.** It is not a defect in our prototype; it is the
measured behaviour of single-instrument fault detection when the fault has no second
observable. We measured it, we recorded why it is structural rather than a threshold
to be moved, and we have a test asserting the corroboration logic *can* confirm when
the evidence is there — so the 0% is known to be about the world, not the code.

---

## Criterion 1 — Strength and originality of the idea (25%)

> Applicants must demonstrate a clear understanding of the ICO's defined challenge and
> the need it addresses; proposals should show alignment with the challenge objectives
> and articulate the business and technical opportunity unlocked.

**Draft:**

The brief asks for solutions that "enable the remote monitoring of USVs… to track
vessel health, detect faults as they occur, and understand the appropriate actions to
take when issues are identified", and names "fault traceability and system
assurance" and "operation in low-connectivity environments" among the key issues.

Underneath those sits a problem the brief does not state, which we believe is the
real constraint: **a fault detected in a confined space on a vessel is usually detected
by one instrument, and one instrument cannot corroborate itself.** A USV's bilge, hull
void, cable duct or machinery space is precisely where a single fixed sensor is the
only sensor that fits. When that sensor reports a deviation, there is no principled
way to separate real degradation from a sensor artefact or a transient — and the
report either raises false alarms, which erodes trust, or stays silent, which is
worse.

We built and validated a research prototype to attack exactly this, three weeks ago.
It is not a digital twin in the marketing sense. It is a *validated* digital twin: a
deterministic, headless simulation of a three-agent indoor inspection swarm, whose
environment contains an authored set of defects that is hidden from the agents, so
detection accuracy is a measured number rather than an opinion. It has a typed event
log as its provenance spine; it replays byte-identically from a seed; it is
constrained to IEEE-754-exact arithmetic so that a metric regression always has a
cause; and it carries 425 passing tests across 20 files, including a test that makes
ground truth unreachable by every sensor and detector, and a test that forbids any
detector from silently returning nothing.

**Its headline result is a negative one, and we think it transfers.** When a fault
exists in a space only one agent can reach, that agent's detection cannot be
corroborated by any other agent, because the fault has no second observable — a
blockage is geometry, not a heat source, and the only other signal a blockage makes
is stagnant air, which is sampled at registers the confined-space agent cannot reach.
We measured this: escalation from the confined-space agent to the one carrying a
second sensor succeeded in **0%** of cases. That is not a bug. It is the measured
behaviour of single-instrument fault detection in a confined space, and it is why
heterogeneous sensor access matters.

**What we propose.** Extend the methodology to a USV monitoring demonstrator in which
(a) the vessel's constrained volumes — bilge, hull voids, cable ducts, pipe runs —
become the second manifold, so a second, differently-sensing agent can reach them and
corroborate; (b) the fault taxonomy is rebuilt for the maritime domain rather than
reused from the building domain; and (c) the whole demonstrator is validated against
authored ground truth, so the output is a *measured* detection and corroboration
rate rather than a claim.

**Why us, and why we are asking.** The Thales brief requires applicants to
"demonstrate they would be able to develop a solution without access to real or
representative data". We can demonstrate that today, because we have already done it.
Our prototype was built and validated with no real or representative data of any kind:
the ground truth is authored, and the environment, sensors, noise model and agents are
all synthetic. We are not proposing to begin that work; we are proposing to point it
at your problem.

We have no maritime or defence sector experience and we would rather say so plainly
than imply otherwise. That is precisely why we are applying to a collaborative
programme rather than proposing to sell you a product.

---

## Criterion 2 — Project delivery and feasibility (25%)

> The applicant should demonstrate that the proposed solution is technically and
> operationally feasible within the programme and budget; provide a clear,
> well-thought-out project plan; demonstrate relevant domain expertise and delivery
> capability; and include consideration of delivery risks with appropriate mitigation.

**Draft:**

We built the prototype in two deliberate layers so that the transfer is visible and
bounded rather than asserted.

**Unchanged.** Approximately 110 KB of the codebase, and effectively all of the trust
in it: the typed event log (every metric must name the events it consumes, or it is
cut rather than approximated); the determinism substrate (IEEE-754 restriction to
`+ - * /` and `sqrt`, fixed iteration counts rather than tolerance-driven
convergence, seeded PRNG, injected tick counter, no wall clock); the reporting and
evidence-pack layer (coverage mandatory, withheld claims, byte-identical JSON); the
sensor noise model; and the browser viewer, which reads simulation frames and writes
nothing.

**Rebuilt for the maritime domain.** The world model (compartments, ducts and voids
rather than rooms and conduits); the sensor suite; the agent set (a deck crawler, a
confined-space crawler, an above-deck drone); the fault taxonomy (21 building
anomalies replaced by a maritime set — water ingress, corrosion, structural cracking,
blocked ventilation, fuel or VOC release, battery degradation); and the detection
rules.

**New work.** Distributed timing across vessels; standards-aligned output; the fault
taxonomy itself, authored jointly with Thales; and a fidelity argument for the sensor
models.

**Plan.** Five phases with a gate at each — see `designs/thales-project-plan.md`.
Months 1–2 domain transfer, 2–4 maritime fault taxonomy with Thales, 4–6 vessel twin
demonstrator with the viewer, 6–8 validation campaign against authored ground truth,
8–9 standards alignment, report and showcase.

**Domain expertise.** Ours is methodological, not maritime. We are explicit about that
and we treat it as a programme dependency rather than a claim: the fault taxonomy and
the manifold definitions are the artefacts we put in front of Thales at the Phase 1
gate for review, with an explicit month-2 decision point to stop rather than persist
if the transfer is not valid. The programme's own structure supplies the rest —
monthly mentoring, challenge-owner access, and the Digital Twin Centre's facilities.

**Risks and mitigations.** Four, each with a mitigation that does not depend on luck:

1. *Fidelity.* Synthetic sensor models will not match a real hull. Mitigation: our own
   spec already holds that all accuracy numbers are upper bounds until compared
   against hardware logs, and we report it that way in every output; making that
   comparison a Phase 4 deliverable rather than a claim.
2. *Transfer validity.* The manifold model may be wrong for a vessel. Mitigation:
   Thales' review at the Phase 1 gate, with a month-2 stop decision.
3. *Standards.* Our output format is currently bespoke. Mitigation: standards
   alignment designed in from month 1, not retrofitted at the end.
4. *Key-person concentration.* Small team. Mitigation: every module carries a written
   spec and a test, so the work is not trapped in one head, and a second engineer is
   committed for Phases 3–5.

**Feasibility against budget and time.** £75,000 over nine months is roughly a
half-FTE project. The first two phases are adaptation of working, tested code rather
than greenfield construction.

---

## Criterion 3 — Financial responsibility (25%)

> The applicant should provide a financial plan with a clear breakdown of costs
> demonstrating good value for money; the proposal should allocate funds appropriately
> between development, testing and project management.

**Draft — indicative nine-month budget**

| Item | Basis | Cost |
|---|---|---|
| Engineering — applicant | 0.5 FTE × 9 months, 97 days @ £250/day | £24,250 |
| Engineering — second engineer (contract) | Phases 3–5, 40 days @ £400/day | £16,000 |
| Marine systems domain expert (contract) | 20 days @ £450/day | £9,000 |
| Standards & interoperability consultant (STANAG, ISO 23247) | 5 days @ £500/day | £2,500 |
| Cloud compute — validation campaign | ≈40,000 run-hours | £4,000 |
| Test rig — sensor mock-ups, small-scale platform | | £3,500 |
| Travel — UK Digital Twin Centre kick-off, three check-ins, showcase | 4 trips | £2,000 |
| IP — patent search, provisional application, legal | | £4,000 |
| Insurance, software licences, 3D asset production | | £2,500 |
| Contingency (10%) | | £6,775 |
| **Total** | | **£74,525** |

**Allocation across the three categories the criterion names**

| Category | Share | |
|---|---|---|
| Development | £52,750 | 71% — engineering, domain expert, standards, IP |
| Testing | £9,500 | 13% — compute, test rig, part of the asset/licence line |
| Project management | £5,500 | 7% — travel, contingency |
| Contingency | £6,775 | 9% |

**Value for money.** £74,525 of £75,000, 99.4%. The programme's own figure for
specialist support is up to £14,000, so the full package is up to £89,000 against a
demonstrator that inherits a validated, tested core. For comparison, the validation
campaign alone in Phase 4 is a measured compute budget — our own suite currently runs
425 tests in 21 minutes, and a corpus run is cheap, which is why we buy 40,000 run-
hours rather than guessing.

**Risks to the budget.** The two that could move it are the marine domain expert
(if Thales supplies a lot of this through the programme, it falls) and the test rig
(if the vessel demonstrator can be run fully in simulation, it falls). Both fall
downward, which is the right direction for a fixed grant.

---

## Criterion 4 — Growth potential (25%)

> The proposal should demonstrate strong potential for growth and scalability beyond
> the accelerator; deliver added value to the challenge owner and extend to wider use
> cases; articulate measurable post-programme goals; and show commitment to continued
> development and commercialisation.

**Draft:**

**The commercial question.** Everyone in the chain — USV operators, OEMs,
classification societies, insurers — is being asked to trust a fault-detection claim
from a system that cannot show it looked in the right place. Today that trust is
carried by the vendor's word and a dashboard. Our position is that it can be carried
by a measurement: not "there were no faults", but "we examined 71% of the vessel's
accessible volume, with this sensor suite, under these conditions, and detected and
corroborated N faults of this taxonomy".

**What scales, and what does not.** The methodology is domain-agnostic by
construction: the harness core — event log, determinism, coverage accounting,
evidence pack, oracle boundary — is deliberately separated from the domain content
(world model, sensor models, agent set, fault taxonomy). We have one working domain
(building inspection). Maritime is the second. The commercial product is therefore not
the harness; it is the **fault taxonomy and the validation record** for a given asset
class, delivered first as a service and then as a tool. That is what the IP in the
harness protects and what the taxonomy monetises.

**Wider use cases, same instrument.** The same measurement question is being asked
and is being answered with assertion rather than evidence in offshore wind (blade
and structural inspection), subsea (cable and riser integrity), rail and road
infrastructure, and autonomous vehicle validation. And closer to the UK
government's stated priority: the identical question applies to an AI system that
*acts* rather than senses — did it actually look, and does the evidence support the
claim — and our method, an authored oracle plus a coverage metric plus a reproducible
evidence pack, is the same instrument.

**Measurable post-programme goals.**

- *Months 9–12:* a paid validation engagement with at least one USV operator or
  OEM, using the demonstrator methodology. Target: two qualified enquiries, one paid
  engagement.
- *Months 12–18:* a maritime fault-taxonomy product — fault catalogue, measurement
  protocol, evidence schema — offered to operators who want to run it against their
  own sensors, alongside the harness under the same terms.
- *Months 18–24:* apply the same instrument to non-physical AI systems, where the
  constraint is identical and the market is materially larger.

**IP.** The programme's terms leave IP with the applicant. We will retain the harness
and the detector methodology as trade secrets, and file on the two genuinely
patentable pieces — the capability-limited corroboration model and the
coverage-multiplied confidence calibration — subject to a search before Phase 3. If
the maritime fault taxonomy is authored jointly with Thales, we will not claim it as
ours.

**What would make us fail, stated plainly.** If the maritime fault taxonomy proves
irreducibly dependent on data we cannot synthesise, the methodology does not
transfer. We will say so at the Phase 2 gate rather than in month 8.

---

## Open items before submission

- [ ] Company incorporated, UK registered, business bank account open. *(Gating.)*
- [ ] Sign in to the SimplyDo portal and read the actual form fields — the public
      challenge record exposes no question schema; it is behind login.
- [ ] Confirm the applicant company name. See note on Templar Ventura.
- [ ] Confirm named second engineer, or replace the engineering line with a
      reduced-scope plan.
- [ ] Thales-facing one-pager: the 0% finding, the method, the ask.
- [ ] Decide whether the demonstrator is named (USV class) or generic.
