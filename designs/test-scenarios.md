# Swarm Inspection Playpen — test scenarios

**Status:** designing
**Date:** 2026-10-01
**Implements:** `swarm-simulation-spec.md` §9 (metrics), §11 (stages)
**Governed by:** `adr-001-sim-view-boundary.md` — determinism is what makes these
repeatable, so a scenario without a fixed seed is not a test.

---

## 1. Rules for every scenario

Non-negotiable, and the reason they are stated before the scenarios rather than
discovered during them:

1. **Fixed seed.** Declared in the scenario definition. A scenario whose result
   varies on re-run is broken.
2. **Control run first.** Every scenario runs at `noiseMultiplier: 0` as well as
   nominal. **If the control is not clean, the nominal numbers are
   uninterpretable** and the scenario fails at its control, not at its target.
3. **Determinism assertion.** The scenario re-runs and compares a state hash at
   tick N. Divergence fails the test regardless of the metric.
4. **Numbers recorded, not thresholds invented.** Pass criteria are stated below
   where there is a defensible bound. Where there is not, the scenario
   **records and compares against a stored baseline** rather than asserting an
   absolute value. Inventing a threshold after seeing a result is how a test
   suite stops testing.
5. **Log retained.** Every scenario writes its event log. A metric without a log
   cannot be diagnosed, which is the whole point of §3 of the ADR.

---

## 2. The control condition

Not a scenario. A precondition for all of them.

**Control:** `house-01`, all three agents, `noiseMultiplier: 0`, seed 1.

Expected: 100% coverage on all three manifolds, all 21 anomalies found, zero
faults, zero starved jobs, ATE ≈ 0.

**This is the most important test in the suite.** It isolates navigation,
allocation and reporting from perception. A failure here is a bug in the
machinery — a wall the ground bot cannot pass, a job no agent can bid on, a
report claim with no detector. A failure at nominal noise with a clean control
is a perception finding, which is interesting.

Run order is therefore: control, then the scenario. Never the reverse.

---

## 3. Scenario matrix

| ID | Question | Stage | Kill condition |
| --- | --- | --- | --- |
| S1 | Can the machinery work at all? | A | Control fails |
| S2 | What does noise cost? | B | — |
| S3 | Can the agents find the anomalies? | B | — |
| S4 | Does closure beat drift, and does calibration earn its keep? | E | Closure makes ATE worse at low noise |
| S5 | Are confined spaces actually reachable? | E | Inchworm cannot complete the 40 mm run |
| S6 | Is the allocation sound? | C | Bot stranded |
| S7 | Does the distributed claim hold? | G | No heal after partition |
| S8 | Is the market earning its keep? | C | Regret ≈ 0 |
| S9 | **Is the heterogeneous swarm worth it?** | H | **Heterogeneous ≤ homogeneous** |
| S10 | Are false positives usable by a human? | B | — |

---

### S1 — Control

**Purpose:** verify the machinery in isolation from perception.

**Setup:** `house-01`, 3 agents at the front door, `noiseMultiplier: 0`, seed 1,
10,000 ticks (1,000 s sim).

**Pass:**
- Coverage 100% on ground, volumetric and constrained manifolds
- All 21 anomalies found, all at confidence ≥ 0.6
- Zero `job.starved`, zero `agent.stranded`, zero `fusion.contested` at end
- ATE < 0.01 m all agents (grid A* and perfect odometry at zero noise)
- State hash identical across two runs

**Failure reading:** any fault here is a logic bug, not a tuning problem. The
specific tells: a stuck agent means the manifold port graph is not connected; a
starved job means a capability token is missing from the agent that owns the
region; an anomaly missed at zero noise means the field is not observable from
that vantage, which means the anomaly is mislabelled.

---

### S2 — Noise sweep

**Purpose:** the sensitivity curve. How much does perception degrade?

**Setup:** seed 1, `noiseMultiplier` ∈ {0, 0.5, 1, 2, 4, 10}, 20 seeds per level
(n = 120 runs).

**Record:** coverage, F1 per class, ATE, false positives, energy.

**Read:** the shape matters more than any single point. Three things to look for:

- **A cliff.** A metric that holds to ×2 then collapses is telling us a detector
  has no margin. A cliff is a design finding — that detector needs a wider
  evidence window.
- **The thermal cliff specifically.** §4.2 was tuned so that a naive
  single-frame threshold loses to a baseline-relative detector at nominal noise.
  If that tuning did not produce a measurable gap, the emitters are either too
  easy or too hard, and both are content bugs.
- **Where ×10 lands.** Very high noise should degrade to near-random. If it
  does not, the agents are using privileged state and something is leaking
  ground truth across the boundary. **This is the scenario most likely to catch
  an architecture violation, and it is worth running early.**

**Baseline:** stored after the first nominal run.

---

### S3 — Detection accuracy by class

**Purpose:** the §9.2 numbers, and the honest per-class table.

**Setup:** nominal noise, seeds 1–20.

**Record:** per class — precision, recall, F1, mean localisation error, mean
extent IoU, false positives per run.

**Expected, stated in advance so it is a prediction rather than a rationalisation:**

| Class | Expect | Reason |
| --- | --- | --- |
| `moisture_leak` | Best recall | Scalar field, long integration, ground bot has the sensor |
| `thermal_anomaly` | Best precision | Strong signal; emissivity error attacks recall, not precision |
| `blocked_vent` | High precision | Geometric, unambiguous |
| `clutter_hazard` | High recall, high FP | Occupancy proxies over-fire by design (§4.6) |
| `structural_crack` | **Worst F1** | Geometric proxy without vision; known-pessimistic |
| `pest_indicator` | **Worst recall** | Requires thermal *and* geometry, in voids — needs the inchworm's access and the hover bot's sensor, i.e. a recombination |

**The two pessimistic classes are the RGB debt made visible.** If they come out
*better* than predicted, the detectors are cheating and the boundary is suspect.

---

### S4 — Loop closure and drift

**Purpose:** does closure earn its keep, and is the gate (§5.2) calibrated?

**Setup:** ground bot alone, 6 m dog-leg corridor, traverse 20 times, nominal
noise. Three variants, because §4.5.1 made calibration a variable and this is
the scenario that measures it:

| Variant | Configuration |
| --- | --- |
| **4a** | Calibrated at dock, closure on |
| **4b** | **Uncalibrated**, closure on — isolates calibration's contribution |
| **4c** | Calibrated, closure **off** — the no-closure control |

**Record:** ATE, RPE, drift rate m/10 m, closure precision and recall — **all as
time series across the mission, not mission averages** (§9.3).

**Pass:**
- Closure reduces final ATE by ≥ 40%
- Closure precision ≥ 0.8 (a wrong closure is worse than none)
- 4b vs 4a: calibration reduces drift rate by **≥ 5×** at mission start. The
  model specifies 6.7× (15% residual); anything under 5× means the calibration
  routine is being under-modelled, and anything at 8× means it is quietly
  approaching the perfect calibration that §4.5.1 rejects
- **Drift rate rises monotonically across 4a** — the decay from 15% to 60% is
  real and observable in the curve

**The 4a-vs-4c comparison is the load-bearing one** and it has a prediction
attached: closure is worth *less* early in the mission and *more* late, because
residual bias grows 4× over the run. So the closure benefit as a function of
trajectory distance should be **increasing**. A flat curve means the calibration
decay is not reaching the pose graph, and one of the two models is lying.

**4b's purpose is calibration, not closure.** Without the uncalibrated control
there is no way to tell a working calibration routine from an IMU that happens to
have a small bias on this seed — and seed-dependence is exactly the failure that
makes a noise sweep uninterpretable.

**The kill condition is the interesting one:** if closure *increases* ATE at low
noise, the distance-transform matcher is firing on genuinely distinct regions
that look alike — a corridor repeated twice. That is a real property of indoor
buildings, and the fix is a stricter gate plus topological constraints
(closures within a manifold, not across a port). **Recorded as a finding if it
happens; not hidden.**

---

### S5 — Confined traversal

**Purpose:** does the constrained manifold actually work?

**Setup:** inchworm on each of the 6 conduits in turn, nominal noise, 5 seeds.

**Status after Stage E (2026-10-02):** the *content* shipped; the *scenario* has
not, and one of its expectations is now known to be unmeetable as written.

Two findings change this scenario:

1. **The constrained manifold has four disconnected components**, not one network.
   inchwormHomePort therefore selects which conduits are reachable at all, so "the
   inchworm on each of the 6 conduits in turn" means one run per component, with a
   home port chosen to make that conduit reachable. Spec 11.22 has the component
   table. A scenario that homes the crawler once and expects all six will starve four
   of them, which is correct behaviour and a broken test.
2. **The under-floor void cannot be lapped twice in a 300 s mission.** At 0.09 m/s
   the whole 300 s budget is 27 m of crawling against a 28.3 m loop, and time spent
   entering, exiting and servicing jobs leaves less. So loop closure is not reachable
   through the market: once coverage saturates there is nothing left to announce and
   the crawler has no reason to re-traverse. It is now tested by a directed survey of
   the 8 m wall cavity loop instead (	est/world/inchworm.test.ts, "graph-relational
   SLAM"), and the perimeter void's landmark spacing is reported as a coverage gap in
   its own right.

The 40 mm assertion below stands and is now enforced in code: waste-sink is
authored with no far port, the loader refuses to declare a loop that does not close in
geometry, and irreversibleRisk returns 1 for it.

**Record:** completion rate, traversal time, energy per metre, localisation error
along arc length, port exit success.

**Expected:**

| Conduit | Expect | Note |
| --- | --- | --- |
| Boiler flue, 150 mm | Clean | Two elbows, the only true 3-D challenge |
| Under-floor void, 140 mm, 18 m loop | **The loop-closure test** | 18 m of arc length accumulates drift; one feature-node revisit available |
| Kitchen extract, 200×300 | Clean | Two branches; a tee is a graph node |
| Under-sink waste, **40 mm** | Completes, no return | Single-file. Entering is committing |
| Wall cavity, 90 mm | Tight | 90 mm vs. 80 mm class boundary — should pass on capability, barely |
| Bathroom extract, 125 mm | Clean | |

**Pass:** all six complete; the under-floor void closes its loop and reports a
localisation correction rather than an unbounded drift.

**The 40 mm run's real assertion:** the inchworm completes it and **exits at a
port**. A run that completes but leaves the bot inside is a failure, because it
means the allocation logic did not account for irreversibility — which is what
S6 tests.

---

### S6 — Battery, allocation and stranding

**Purpose:** is the auction sound under energy pressure?

**Setup, three variants:**

- **6a** nominal battery
- **6b** 40% battery
- **6c** 30% battery, hover bot start at 15%

**Record:** stranded agents, starvation events, allocation regret, Wh per
confirmed anomaly, energy split by subsystem.

**Pass:**
- Zero stranded agents in all three variants
- Bids with insufficient headroom are never awarded
- At 6c the hover bot is used only for jobs it is the *only* eligible bidder on

**6c is the sharpest test in the suite.** The hover bot burns 86 W with a 22 Wh
battery — 4.4× worse endurance than the ground bot. At 15% charge it has ~2
minutes of hover. A sound allocation spends it only where nothing else can go
(ceiling voids, attic, shaft); an unsound one sends it to scan a fridge from 2 m
away, which the ground bot can also do, and the swarm dies with 80% of the
house unmapped.

**This is the scenario that justifies the entire §6.3 score function.** If a
greedy nearest-eligible-agent rule passes 6c, the battery term is decoration.

---

### S7 — Comms partition and heal

**Purpose:** does the distributed claim survive losing the bus?

**Setup:** ground + inchworm, fuse comms for 600 ticks at nominal noise, then
heal. Three agents, partition isolating the inchworm in the duct network.

**Record:** coverage during the partition, queue depth, fusion residual before
and after, time to full recovery, contested region count.

**Pass:**
- Agents fall back to local exploration; no agent halts
- On heal, fusion recovers with residual within 20% of the un-partitioned run
- **No fused-map claim is made about the partitioned region during the outage**
- ≥ 90% of pre-partition coverage retained within 200 ticks of heal

**The third pass condition is the architectural one.** An architecture that
publishes a confident fused map while holding unregisterable chunks is lying,
and spec §13.5 predicted it would understate inconsistency. If the partition run
shows confidently wrong fusion, the distributed claim does not hold as specified
and the fix is a per-region covariance inflation, not a better metric.

---

### S8 — Auction versus greedy

**Purpose:** does the market beat the obvious thing?

**Setup:** nominal noise, 20 seeds, three allocators compared on identical runs:

- full §6.3 score
- nearest-eligible-agent
- round-robin

**Record:** completion time (mean, p95), makespan, Wh per anomaly, regret,
starvation count.

**Pass criterion, stated as a comparison rather than an absolute:** the full score
wins on at least two of {p95 completion time, Wh per anomaly, starvation count},
with no regression worse than 5% on the third.

**Kill condition, and this is the one worth caring about: if regret is under 2%
across 20 seeds, delete the auction and keep greedy.** An allocator that beats
greedy by nothing is 60 lines of scoring function, six new failure modes and a
tuning surface that will be a bug factory. **The scenario's purpose is to allow
its own deletion.**

**Precondition, added at Stage E, and it should have been here from the start:**
regret is only readable when an award had a *second eligible bidder*. uctionVerdict
returns 
ot_evaluable below five contested awards, and the threshold is not
consulted at all.

Stage E measured mean regret 0.00% over 37 awards with **zero contested** - two
agents on different manifolds never compete for the same job. An earlier version of
this check tested gents.length < 2, which was correct with one bot and became wrong
with two: it would have cleared the two-agent run to print "delete the auction" on the
strength of an experiment that had not run. So the precondition is on the *awards*,
which is the only place the property exists.

**To make S8 decidable:** two eligible agents on the same manifold. Either a second
ground bot, or the hover bot at Stage F.

---

### S9 — The thesis test

**Purpose:** does the heterogeneous swarm justify itself?

**Setup:** nominal noise, 30 seeds, two swarms with matched total energy:

| Swarm | Composition | Total energy |
| --- | --- | --- |
| **H** Heterogeneous | ground + inchworm + hover | 72 Wh |
| **A** All-ground | 3 × ground, no inchworm, no hover | 72 Wh |

**Note the constraint:** matched energy, not matched headcount of capability.
Three ground bots cannot enter a 40 mm bore at any energy level. That is the
honest comparison — the question is not whether a homogeneous swarm *could* do
the job, it is whether spending the same energy on capability beats spending it
on redundancy.

**Record:** confirmed anomalies per Wh, coverage of constrained + volumetric
manifolds, total completion time, false positives.

**Pass — the thesis criterion:** H detects strictly more anomalies per Wh, and
H's constrained-and-volumetric coverage exceeds A's by a margin worth the
complexity.

**The predicted mechanism, stated in advance:** H wins on `pest_indicator` (2
anomalies) and on constrained-manifold coverage, and roughly ties with A on
ground coverage and false positives. If H instead wins everywhere, something is
wrong with the energy accounting. If H wins only marginally, the recombination
case in §7.1 is not real and §0's bet is falsified.

**Secondary criterion — recombination is load-bearing:** ≥ 3 of the 21 anomalies
are confirmed only by a composite observation, and each such confirmation has a
recorded positive confidence delta.

**What this scenario does not test:** whether real hardware could do this. It
tests whether the architecture is worth building. That is the question available
without hardware, and it is a real one.

---

### S10 — Usability of the output

**Purpose:** is the report usable by a human, or only by the metrics?

**Setup:** run the nominal scenario. Hand the report to a reader with no access
to the sim.

**Count, by hand:**

| Measure | Target |
| --- | --- |
| Findings in the report | ≤ 35 (21 true + ≤ 60% FP) |
| Confirmed with a detector ID | 100% |
| Negative claims about regions under 85% covered | **0** |
| Findings marked `UNVERIFIED` that a second pass confirmed | Any — the mechanism is what is tested |
| Uncovered regions named in the report | All of them |

**The third row is a hard assertion, enforced in the report generator's unit
tests, not a reading exercise.** Spec §8.2 rule 2 says the generator physically
cannot emit a negative claim about an under-covered region. This scenario checks
the integration.

**A report with 71% coverage and 21 clean findings is worse than one that says
"stairwell not fully inspected"** — and the fact that the first is easier to
produce is exactly why this is a test.

---

## 4. Suite summary and execution budget

| ID | Seeds | Runs | Wall clock (est.) |
| --- | --- | --- | --- |
| S1 Control | 1 | 1 | ~2 s |
| S2 Noise sweep | 20 | 120 | ~6 min |
| S3 Detection | 20 | 20 | ~1 min |
| S4 Closure | 10 | 20 | ~30 s |
| S5 Confined | 5 | 30 | ~40 s |
| S6 Battery | 10 | 30 | ~50 s |
| S7 Partition | 10 | 30 | ~1 min |
| S8 Auction | 20 | 60 | ~2 min |
| S9 Thesis | 30 | 60 | ~2 min |
| S10 Report | 1 | 1 | — |
| **Total** | | **~370** | **~14 min** |

Runs headless in CI in one job. **This is the whole argument for the engine
choice:** 370 full-mission simulations with sensor noise, SLAM, allocation and
reporting, in fourteen minutes, is what makes the metric a measurement rather
than an anecdote. On hardware this suite is a research programme.

---

## 5. Gaps, recorded honestly

Known coverage holes in this suite, so they are decisions rather than oversights:

1. **No multi-agent interference scenario.** Three agents in a corridor can
   physically collide. No scenario tests congestion. If the viewer shows agents
   routinely blocking each other, this suite will not have caught it.
2. **No dust, darkness or low-visibility condition.** §4.6 cut RGB, and with it
   the dominant environmental degradations. Spec §13.4's "navigation is
   optimistic" is understated because of this.
3. **No hardware fidelity check.** Every number is against an authored house. The
   upper-bound claim in §13.1 cannot be discharged inside this project.
4. **Single house.** Twenty-one anomalies in one layout. Scenario variety comes
   from noise, battery, comms and allocator — not from environment variety. Two
   houses would be the highest-value addition to this suite and the cheapest
   meaningful one, since the environment is authored as JSON.
5. **S10 is the weakest test.** One run and a hand count. It is here because the
   failure it guards — a confidently wrong report — is the one that would
   actually damage someone relying on this work.
6. **No temperature-dependence in IMU bias.** §4.5.1 models bias decay over
   mission time, but real MEMS bias moves with *sensor temperature*, and a bot
   that flies into a boiler room has a different bias than one that has not. The
   time model is a proxy, and a hover bot entering an attic is the case where
   the proxy will be visibly wrong. Recording it because the fix is cheap later
   and expensive to retrofit.
7. **S3 ran at Stage B, and two of its six predicted orderings did not survive.**
   Thermal is not the most precise class (a unary geometric blocked-vent test beats
   it), and thermal localises *worse* than the bearing-less humidity sensor
   (1.49 m vs 0.38 m). The recall predictions held. Spec §11.5 has the reasoning.
   **S3's numeric pass criteria should be re-derived from the measured numbers
   before Stage E** rather than left as originally written — a threshold invented
   before the data exists is a threshold fitted to nothing.
8. **A detector that returns nothing is indistinguishable from a clean building.**
   That bit twice at Stage B: a magnitude gate of 118 K silenced the naive control
   for an entire stage, and every wall in the house had zero surface observations so
   two geometry detectors reported a plausible `0.00`. The suite has no general
   guard against it. The cheap fix — assert that every registered detector
   produces at least one candidate over the control scenario — is listed as a
   Stage C task rather than written late, because it is a property of the harness
   rather than of Stage B.
9. **Stage E hit gap 8 three more times, in a new place.** The crawler's landmark
   test re-fired every tick it sat near a node: 2638 loop closures over 25 m, a
   "drift rate" of 0.085 m per 10 m made of numerical noise, and a crawler stalled
   in a 1 m oscillation so coverage read 10.7% of a 28 m conduit. driftRatePer10m
   was also not a rate - it returned mean(error) x 10, and reported a drift larger
   than the drift it was supposed to be measuring. The inchworm raises no candidates
   at all (it has no thermal sensor), so the existing guard cannot see this class of
   failure: it lives in a subsystem that legitimately produces nothing. Stage E's
   answer was a landmark latch plus 65 tests asserting that each metric can fail, but
   **the general guard for "a subsystem that should emit emits nothing" is still
   missing for anything that is not a detector.**
10. **A port's manifold pair does not say what the port is.** Stage E's five new
   constrained-to-ground ports were all inferred to be ventilation registers by
   detectBlockedVent, which selected on "one side is ground". It fired at the
   boiler flue - one metre from the real blocked vent it was already finding. A true
   positive reached for the wrong reason, which passes a precision check. Fixed by
   authoring Port.kind (ent / conduit_entry / hatch). Recorded as gap 10
   because **the same inference is available anywhere else the code reasons about a
   port**, and only the blocked-vent call site has been checked.
11. **The under-floor perimeter void is under-instrumented.** Landmarks at arc 3.0,
   8.4 and 13.5 leave the last 14.84 m with no fix, which at 0.8% odometry scale
   error is 11.9 cm of uncorrected drift - within an inch of the 0.12 m arrival
   tolerance the crawler is judged against. The bound is reported rather than the
   content being tuned until the number looked good. Two more landmarks would close
   it; that is a content decision, not a code one.
12. **No scenario yet drives S5 or S6 as written.** Stage E built and tested the
   mechanisms both scenarios need - the 40 mm dead end, irreversibleRisk, port
   traversal, graph-relational SLAM - but the scenario *runs* are still absent. What
   exists is a diagnostic (
pm run diag:inchworm) and unit tests. S5's stated
   expectation that all six conduits are reachable in one pass is not satisfiable,
   because the constrained manifold has four disconnected components (spec 11.22).
13. **Stage E's gate is only half delivered, and the honest statement is which
   half.** The gate reads "Inchworm findings hand off at a port and get confirmed".
   Traversal, capability-limited entry and the irreversible case are built and
   tested. The handoff is **not** � the inchworm raises no candidates at all
   (spec 3.2 gives it no thermal sensor and no air sensor), so there is nothing to
   hand off. The handoff path therefore remains unexercised, which means spec 6.4
   mechanism 1 has never run. Building it needs a depth-based in-bore detector and
   a port-anchored corroboration step, and the confirmation rate it will produce is
   unknown: a ground bot at a penetration can sample the air and the wall around it,
   but it cannot see inside the pipe. A low confirmation rate would be a real
   result about how much of the constrained manifold is inspectable at all, not a
   defect to tune away.
14. **The ground-manifold fields are a ground-plane projection, and four authored
   anomalies depend on it.** uildField samples a 2-D (x, z) grid and ignores y,
   so a defect under the floor raises the reading a floor-level robot gets. Scoping
   sources by nomaly.manifold was tried and reverted: it rewrote 1034 of 1536
   temperature cells by up to 11.3 K and dropped pest_indicator recall to 0.00,
   because ml-04, v-02, v-03 and pi-02 are on the constrained manifold
   simply because that is where they were authored, while their thermal signature is
   what the ground sensors detect. Recorded because **the inconsistency is real and
   still there** � a per-manifold field is the right answer and belongs with the
   volumetric field in Stage I, not as a filter on a 2-D grid.
15. **pickFrontier() === null is treated as mission-complete, whatever the
   coverage figure.** An agent with no reachable frontier simply stands still. For
   an agent that has genuinely finished its coverage that is correct; for an agent
   whose surroundings are unreachable it is indistinguishable from having nothing
   left to do. The stall monitor now covers the drive path and plan consumption, but
   not this branch, which resets the counter to zero � so an agent that cannot reach
   any frontier reports clean indefinitely. Reachable in principle after a stranding
   recovery; not yet demonstrated.
16. **The handoff mechanism works and the confirmation rate is 0%, and the rate is
   the finding.** Stage E's gate is now met: the crawler raises a suspicion, it is
   escalated to the nearest reachable port, and a thermal-capable agent works the job.
   Nothing corroborates any of it. Two structural reasons, neither of which is a
   threshold to move: the corroboration test reads thermal candidates and in-bore
   obstructions are authored with sourceStrength: 0 (an obstruction is geometry,
   not a heat source), and the only other signal a blockage produces is stagnant air,
   which detectBlockedVent only samples at *air registers* - and conduit entries are
   conduit_entry by design. Spec 11.25 has the reasoning and the open question about
   whether a conduit entry should be a partial air register. **The number must not be
   improved by changing the world until it improves.**
17. **Four of the seven constrained-manifold defects are unreachable by construction.**
   ml-04, v-02, v-03 and pi-02 are labelled constrained with no conduit and
   no arc, so no crawler can route to them and no bore scan can see them. They will
   score zero recall. This is the structural_crack finding again - a defect no agent
   can get close enough to see is a defect no agent can report - and it is recorded
   rather than fixed by moving the content somewhere a detector happens to look.
18. **S8 is decided, and the remedy is not "round-robin" - it is two rules.** The kill
   condition fired: mean regret 0.000% nominal and 0.023% with the crawler, across
   800 contested awards, with the winner not being the nearest bidder in **one award
   out of 1024**. The scoring function is deleted. What survives is nearest-eligible
   plus an irreversible-commitment veto - and the veto is the only thing that still
   distinguishes the allocator from pure greedy, which is precisely why it survived the
   cut while three inert score terms did not. Spec 11.26.
19. **The browser-parity pin has not been verified since Stage E part four.** It has
   moved twice since then (twice for legitimate reasons, with behaviour provably
   unchanged), but the browser tooling available cannot execute page script and does
   not expose table cell text through its accessibility snapshot, so the viewer's hash
   cannot be read. ADR-001 2.2's byte-level cross-engine claim is therefore currently
   **unverified**, while its structural claim holds and is enforced. Recorded as a
   liability: anyone with a working headless browser should confirm or correct the
   constant before relying on it.
20. **S9 has not been run, and it is the experiment that could reinstate the allocator.**
   S8 compares two identical ground bots, where capability, battery and load cannot
   bind because the agents are homogeneous and 10 m apart. The thesis test compares a
   heterogeneous swarm to an energy-matched homogeneous one, which is a different
   allocation problem. The regret measurement has been kept running specifically so that
   question can be answered with numbers rather than intuition.
### S9 - run, as far as it can run, and it is the control arm

**The specced setup was confounded by 58%.** The table says both arms are 72 Wh. The
all-ground arm is 3 x ground = 114 Wh. Re-matched here on energy and headcount: H is
ground(38) + inchworm(12) = 50 Wh with 2 agents, A is 2 x ground at 25 Wh = 50 Wh with
2 agents, so capability is the only difference.

**My first fix reproduced the confound.** The matching used initialBatteryFraction =
50/38 = 1.3158, and createRun clamps it to 0..1, so the "energy-handicapped" arm was
granted 74.50 Wh against H's 47.29 - a 57% over-credit, against the spec's 58%. The
first run of this experiment was discarded rather than reinterpreted. Corrected, the
granted packs are 47.34 vs 48.44 Wh.

**Correcting it moved no result,** because energy is not binding at 300 s: the ground bot
spends 2.87-3.33% of its pack. Two findings, and only the first is about the code.

**This is the control arm, not the thesis test.** The thesis is "a heterogeneous swarm
pays only if recombination helps evidence", which predicts that capability *without*
recombination should lose. Recombination clusters are Stage H and do not exist.

30 seeds, paired on seed:

| metric | H (ground+crawler) | A (2 x ground) | paired |
| --- | --- | --- | --- |
| ground anomalies confirmed | 9.33 | 10.17 | A better 22, H better 0, tie 8 |
| ground false positives | 19.40 | 16.77 | A better 28, H better 0, tie 2 |
| ground coverage @60 s | **68.73%** | **95.50%** | A better **30**, H better 0 |
| constrained coverage | **49.41%** | 0.00% | H better **30**, A better 0 |
| of those, confirmed at a port | **0.23** | 0.00 | - |
| confirmed per Wh actually used | 3.611 | 6.529 | A better 30, H better 0 |

Predictions: **P1 fails**, P2 and P3 hold, P4 holds. H is ahead on 5 of 30 seeds and tied
on 4, so "H never wins" would be the wrong summary - the claim is about the mean.

**P2 and P4 were amended after the first run.** They were first measured at the 300 s
mission, where coverage saturates at 100.00% in both arms and carries no information, so
they were re-registered at 60 s. Recorded as an amendment because a prediction changed to
match its result is not a prediction.

**The ceiling is 2 defects,** and that is a fact about the house: only 3 of 7 constrained
defects have a conduit target, and the manifold is four disconnected components. Both
reachable ones carry sourceStrength: 0, which is the structural reason in-bore
suspicions corroborate so poorly.

**The target this produces for Stage H:**

| | |
| --- | --- |
| ground confirmations given up | 0.8334 |
| constrained ceiling reachable | 2 |
| **required in-bore confirmation rate** | **41.7%** |
| **measured** | **11.7%** |
| **shortfall** | **3.6x** |

Recombination must convert in-bore suspicions into evidence at 41.7% for the crawler to
pay for itself here, and that break-even still ignores the 26.77 pp coverage loss. If
Stage H cannot reach it, this content does not support a crawler at all - worth knowing
before Stage I adds a third agent. Spec 11.27.
21. **S9 ran as a control arm and P1 failed**, which is the predicted outcome rather than
   a refutation: the thesis is that recombination pays, so capability without
   recombination losing is what the thesis expects. What it produces is a target rather
   than a verdict - recombination must reach a **41.7%** in-bore confirmation rate for the
   crawler to justify itself, against **11.7%** measured. Spec 11.27.
22. **The specced S9 comparison was confounded by 58%, and my first fix reproduced it to
   within a point.** The all-ground arm was 114 Wh against 72 Wh; my initialBatteryFraction
   of 50/38 = 1.3158 was clamped to 1.0 and granted it 74.50 Wh against H's 47.29. Fixed
   to 25/38. The lesson is recorded as a general one: a config value that gets clamped is
   a value that is not the value you set, and a matching claim never checked against the
   granted result is decoration. diag:s9 now prints the granted pack as a row.
23. **Energy is not a binding constraint on the ground manifold at 300 s** - the ground bot
   spends 2.87% to 3.33% of its pack. This is why correcting the clamp moved no result,
   and it means the whole energy-matching exercise, in both the spec and the fix, was never
   going to bind. A confound repaired and left unchanged is a different fact from one
   repaired and consequential, and only running the corrected version distinguishes them.
24. **Four of the seven constrained defects have no conduit target, and the constrained
   manifold is four disconnected components,** so H's constrained ceiling is 2 defects
   regardless of any crawler design. Both reachable ones carry sourceStrength: 0, which
   is the structural reason in-bore corroboration is low. The structural_crack finding
   again, now with a number attached.
25. **The volumetric manifold has no scalar field of its own, so nothing on it is
   private.** An attic thermal defect is detected by the ground bot: jobs 40 -> 45, done
   31 -> 36, hash 8f9dfce8 -> 97d5ccef. The fields are ground-plane projections that
   ignore y, so two defects 3 m apart vertically produce byte-identical fields. Consequence:
   **an attic thermal defect does not justify a hover bot** - so the bot's unique value is
   ceiling *coverage*, not ceiling *detection*, and only the second was tacitly assumed.
   Spec 11.28.
26. **Stage F's content was broken and no test caught it.** No attic at all, so the hover
   bot's 1.0 m clearance never bound; a port at y = 4.0 in a world whose ceiling was 2.6;
   zero overhead geometry; 1 of 3 volumetric defects with an eligible sensor. Fixed, and a
   load-time check now rejects any port outside world bounds. Spec 11.28.
27. **The attic is deliberately empty of defects.** Authoring a thermal defect there made
   it ground-visible and would have "justified" the hover bot with a prize placed by
   hand. Whether ceiling work justifies a 4.4x endurance penalty is what Stage F has to
   measure, and it does not get to place the payoff first.
28. **headroomAt returned the column total, not the tallest contiguous free run.** 3.50 m
   over a hall-and-attic column, which would have made the 0.90 m constraint look free.
   Split into reeRunsAt and headroomAt. Caught by its own first probe, before it
   reached a number anyone relied on.
29. **The volumetric manifold was fragmented into six components, one per room,** because
   free space was the union of room AABBs and rooms do not overlap at their doorways. Fixed
   to match the 2-D model (bounds minus obstacles). **Nothing reads house.rooms except
   validation**, so rooms are decoration and an attic must be authored as obstacles. Spec
   11.29.
30. **Body clearance reserved room that was not there.** Dilation rejected only authored
   obstacles, so room and world boundaries - which are "inside bounds", not obstacles -
   were invisible to it: **13.08% of all free air** granted 0.20 m of phantom clearance.
   Spec 11.29.
31. **eached did not mean reached**, in both planners. An out-of-world goal was clamped
   into the grid and reported eached: true with a 5.60 m path into empty space; a goal
   inside geometry was substituted with a nearby voxel and still reported success, which
   would have let an arrival test complete a job on arrival next door. Latent in the 2-D
   case - the pin staying at 8f9dfce8 proves it - so it needed a guard rather than an
   assumption. Spec 11.29.
32. **Both pre-registered endurance predictions were contradicted, and that is the finding.**
   E1 "cannot run out at 300 s" holds for cruise (808 s) and fails for high flight: at 2.2 m
   in a 2.50 m room the draw is 462.6 W and endurance 171 s. E2 "the gate is not evaluable"
   fails too - the gate **is** evaluable, conditional on altitude rather than on the agent.
   Recorded as contradicted, prediction text left intact beside the correction. Spec 11.30.
33. **The worst clearance in house-01 is not the attic.** At 2.0 m in an ordinary room the
   gap above is 0.50 m against the attic's 0.60 m. What matters is altitude everywhere, not
   which room is low-ceilinged - a planner routing by room name would do exactly backwards.
34. **The blockage model extrapolates above y = 2.0 m** (blockage 0.80, multiplier 5.0), where
   1/(1-b) stops being a small-disturbance correction. Deliberately not smoothed: a fit
   that stayed gentle there would have hidden the finding that the constraint bites at all.
35. **Spec 3.3's "roughly 4.4x worse endurance" measures 4.70x**, and 5.4's 0.10 m voxels
   imply the bot needs 1.20 m of vertical room. Both corrected in the spec rather than left
   disagreeing with a test.
36. **Endurance is enforced by the capability filter, not the ranking.** ground.drive is
   absent from the hover bot's capabilities, so eligibility() refuses every ground job and
   it never bids. This is how 11.26's deleted battery term is supplied by something stronger,
   and why the two findings are compatible rather than contradictory.
37. **The stage F ceiling gate is met but is a weaker claim than it reads.** A perfectly
   rastered, perfectly consistent ceiling with zero deviation scores 1.000 and passes 0.6,
   because confidence measures survey coverage and agreement, not detection. It cannot be read
   as "the hover bot finds what the ground bot misses". Spec 11.31.
38. **The volumetric manifold still contributes no detection the ground manifold lacks** (from
   11.28), so the raster's honest content is geometric: coverage and height, not findings.
   What would make it the thesis's claim is volumetric-only *content* - a defect visible from
   height and not from the floor - and its absence is now the binding constraint on the thesis
   rather than a content gap.
39. **The depth sensor and the clearance model were two sources of truth for the same fact.**
   The sensor could not see the attic roof (it was the bounds edge, not an authored surface)
   and so reported unlimited headroom where the model said 0.60 m. Fixed; they now agree
   exactly at four probe heights. Spec 11.31.