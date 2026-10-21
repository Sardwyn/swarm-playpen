# Swarm Inspection Playpen

A deterministic, headless simulation of a three-agent indoor inspection swarm,
plus a browser viewer that reads simulation frames and writes nothing.

**No hardware.** The point is ground truth: the anomaly field is authored and
hidden from the agents, so "detection accuracy" is a number rather than an
opinion.

- **Spec:** [`designs/swarm-simulation-spec.md`](designs/swarm-simulation-spec.md)
- **ADR:** [`designs/adr-001-sim-view-boundary.md`](designs/adr-001-sim-view-boundary.md)
- **Scenarios:** [`designs/test-scenarios.md`](designs/test-scenarios.md)

## Status

**Stages Aâ€“E built, all gates passed.** Ground and constrained manifolds. 224 tests
green, typecheck clean, `vite build` clean.

Detection on the ground manifold: **recall 1.00 on every class the detectors can
reach**. Precision is the weak axis, which is the expected shape of a v1 with RGB
deferred.

Jobs: 40 announced / 31 done / 9 starved per 300 s run, every starvation logged.

**The allocator was cut.** Spec 9.4 pre-registered a kill condition - mean allocation
regret under 2% across 20 seeds, delete the auction and keep greedy. It fired. Across
three arms and 800 contested awards, mean regret was 0.000% nominal, 0.000% at 30%
battery, and 0.023% with the crawler - and the winner was **not** the nearest bidder
in **one award out of 1024**. Three of the five score terms were measured incapable of
discriminating: one read 1.0 for 100% of bids, one was clamped flat, and
`capabilityFit` was a constant because eligibility had already filtered the agents
that would have scored lower.

What survives is nearest-eligible plus an irreversible-commitment veto - and the veto is
the only part that still differs from pure greedy. It was a -2.0 weight before, which
a nearby enough 40 mm trap could outbid; as a rule it cannot. **Deleting the scoring
function made the safety property stronger.** The regret measurement is kept running so
the decision can be revisited with evidence, because S9 is a different swarm and a
different allocation problem.

**The volumetric manifold then turned up a model error and three bugs of mine.** Free
space was the *union of room AABBs*, which measured as **six connected components, one
per room** — rooms do not overlap at their doorways, so every doorway came back
`VOXEL_OUTSIDE` and each room was sealed inside its own walls. The 2-D grid does the
opposite: free space is the bounding box and walls do all the separating. Matching that
gives **1 component** and an attic reachable through the hatch.

The other three would all have made the clearance look cheaper or the routes better than
they are:

| | |
|---|---|
| body clearance ignored room and world boundaries | **13.08%** of all free air (22,388 voxels) was handing the bot 0.20 m of clearance through surfaces that are not there |
| index decomposition was non-integer | path steps came out at **1.607 m** where the longest legal 26-connected move is 0.173 m — a sequence of teleports |
| `reached` did not mean reached | a goal outside the world was clamped in and reported `reached: true` with a 5.60 m path into empty space |

The 2-D planner had the same latent clamp, and was fixed the same way — the pin staying at
`8f9dfce8` across the fix is the proof it was inert rather than live. `MinHeap` moved to
`nav/heap.ts` and is imported by both planners, because two implementations of a tie-break
are how tie-breaks drift.

**Clearance binds as a cost, not a wall**, which answers spec open question 1 with a
number: the dilated mask leaves **0.50 m** of usable height in the 0.90 m attic against a
1.00 m clearance, so the bot can fly in and clearance makes it expensive. Folding
clearance into occupancy would have answered the question by fiat. Spec 11.29.


**Then I built the hover bot, and both of my endurance predictions were wrong.** I
registered E1 "cannot run out on a 300 s mission" and E2 "so the gate is not evaluable".
E1 holds for cruise (808 s) and fails for high flight:

| altitude | draw | endurance | vs 300 s |
|---|---|---|---|
| y = 0.3 m | 111.3 W | 711 s | 2.4x |
| y = 1.8 m | 151.7 W | 522 s | 1.7x |
| y = 2.0 m | 189.8 W | 417 s | 1.4x |
| **y = 2.2 m** | **462.6 W** | **171 s** | **0.57x — runs dry** |

**The binding condition is not that the hover bot is expensive. It is that it flies
high.** Below ~2.1 m in a 2.50 m room there is comfortable margin; at 2.2 m there is
none. E2 is contradicted too, and the correction is *better* than the prediction: the
gate **is** evaluable, just conditional on altitude rather than on the agent.

Two more measured findings. **The worst clearance in the house is not the attic** — 2.0 m
in an ordinary room leaves 0.50 m, tighter than the attic's 0.60 m — so a planner routing
by room name would do exactly backwards. And **endurance is enforced by the capability
filter, not the ranking**: `ground.drive` is absent, so the hover bot never bids for ground
work, which is how §11.26's deleted battery term is supplied by something stronger. The
`Math.hypot` ban also caught me on new code, which is the boundary test still working.
Spec 11.30.
**Then volumetric sensing — and the depth sensor was lying about the roof.** An up-ray in
the attic returned *no hit*, so the sensor reported unlimited headroom in the one room whose
headroom is the whole point, while the clearance model correctly said 0.60 m. **Two sources
of truth for one fact, and the sensor was the wrong one**: free space is ounds minus
obstacles, so the top of the grid is the inside of a shell that is only partly authored.
Leaving the grid now counts as hitting the world, and the two agree exactly at four probe
heights. A ray starting inside a wall also now says ace: 'origin' rather than returning a
plausible-looking distance: 0.

**The ceiling gate passes, and it is a weaker claim than it reads.** The stage F gate "ceiling
rasters at =0.6 confidence" is met — and a perfectly rastered, perfectly consistent ceiling
with *every deviation at 0.0 K* scores 1.000, because confidence measures survey coverage and
agreement, not detection:

| raster | confidence | passes 0.6? |
|---|---|---|
| empty | **0.000** | no — and 0, not a vacuous pass |
| full, two consistent passes | 1.000 | yes |
| **full, one pass only** | **0.578** | **no** |
| 3 perfect cells of 576 | 0.002 | no |
| full, 8 K disagreement | **0.000** | no |

So the gate says the bot *was there and measured consistently* — not that it found anything
the ground bot misses. Coverage is multiplied into confidence rather than averaged, so three
perfect cells out of 576 can't report 1.0, and the 0.578 is the calibration that matters:
**one pass over a ceiling is a glimpse and does not pass.** Spec 11.31.
**Stage F started with the content, and the content was broken.** Before writing any
hover bot I read what the stage gate would be measured against, and found four defects
the tests had not caught - including **no attic anywhere**, which would have meant the
hover bot's 1.0 m ceiling clearance **never binds**. A constraint that does not bind
reads exactly like a constraint that costs nothing, and those are opposites. This is the
same failure this project has now found five times: a subsystem returning nothing looks
like a clean result. Fixed: an attic with **0.90 m** headroom, a real hatch through the
ceiling, a ceiling that exists, and a load-time check that rejects any port outside world
bounds - `shaft-cap-garage` had been sitting at y = 4.0 in a world whose ceiling was 2.6
for the whole of Stage A-E.

**Then the finding that reframes the stage.** I authored a thermal defect in the attic and
the *ground bot found it*:

| | without it | with it |
|---|---|---|
| jobs announced | 40 | **45** |
| jobs done | 31 | **36** |
| log hash | `8f9dfce8` | `97d5ccef` |

A defect 3 m above the hall floor, detected by a robot that never left it. The scalar
fields are ground-plane projections that ignore y, so **two defects 3 m apart vertically
produce byte-identical fields** - now a test. I removed the defect, and verified the
hash returned exactly to `8f9dfce8`, which also showed the attic, the bounds change and
the port edits are all inert for the ground manifold.

The consequence is narrow and it is the point: **an attic thermal defect does not justify
a hover bot, because the ground bot sees it through the floor.** So what the hover bot
uniquely provides is ceiling *coverage* - space that must be flown through - not ceiling
*detection*. Only the second was tacitly assumed. Removing the defect was right on the
merits: authoring a prize in the attic and then concluding the bot must fetch it is
circular. The attic is deliberately empty and Stage F has to measure its worth.
Spec 11.28.

In practice the volumetric manifold currently contributes **nothing the ground manifold
cannot already see** - 1 of its 3 defects is sensor-eligible, and that one leaks
downward. That is the number Stage F has to beat.

**S9 ran, and it is the control arm - not the thesis test.** The thesis is "a
heterogeneous swarm pays only if recombination helps evidence", which predicts
capability *without* recombination should lose, so that is the control. At matched
energy and matched headcount, spending 12 Wh on a crawler instead of a second ground
bot costs **26.77 points of ground coverage, on 30 of 30 seeds**, and buys a ceiling of
**2 defects** (the only in-bore defects in a component the crawler can enter).

What it produces is a target rather than a verdict:

| | |
|---|---|
| ground confirmations given up | 0.8334 |
| constrained ceiling reachable | 2 |
| **required in-bore confirmation rate** | **41.7%** |
| **measured** | **11.7%** |
| **shortfall** | **3.6x** |

Recombination has to reach 41.7% for the crawler to pay for itself on this house, and
that break-even still ignores the coverage loss. If Stage H cannot reach it, this
content does not support a crawler at all - worth knowing before Stage I adds a third
agent. Spec 11.27.

Two process notes, because both were errors in my own work. The spec's S9 setup was
confounded by 58% (114 Wh against 72 Wh), and my first fix used
`initialBatteryFraction = 50/38 = 1.3158`, which `createRun` clamps to 1.0 - so the arm
I was trying to handicap was granted 74.50 Wh against 47.29, reproducing the original
confound to within a point. That run was discarded rather than reinterpreted. Fixing it
moved no result, because energy is not binding at 300 s: the ground bot spends under
3.5% of its pack. **A config value that gets clamped is not the value you set, and a
matching claim never checked against the granted result is decoration.** `diag:s9` now
prints the granted pack as a row rather than asserting it in prose.

**Stage E added the inchworm.** It crawls a lumen graph of six conduits, localises
graph-relationally on a 1-D manifold, and closes loops on authored landmarks. Two
findings worth knowing before reading its numbers:

- **The constrained manifold is not connected.** The six conduits form **four**
  disconnected components, so `inchwormHomePort` decides which of them the swarm can
  work at all and the rest are unreachable. This is the strongest evidence yet for
  spec Â§2.4's port rule, and it is a property of the house rather than of the model.
- **Stage E improves the swarm without justifying the auction.** Jobs completed went
  32 â†’ 38 with the crawler present, and 88.7% of the 28 m perimeter void got
  surveyed. But the crawler took coverage jobs *off* the ground bot rather than
  competing for any. "The swarm did better" and "the swarm allocated better" are
  different claims and only the first is supported.

**The viewer runs the same simulation as the tests** - and the parity pin is
currently *not* browser-verified. It was at Stage D: the browser and Node both
produced log hash `2923fbf7` for seed 1, and the constant is pinned in the suite so
parity cannot silently rot. It has since moved twice for legitimate reasons (once by a
port being mistaken for a ventilation register, once by deleting the score function),
and both times the behavioural invariants - tick, coverage, job tally, all six
per-class metrics, energy - were unchanged and are now pinned separately.

What is **not** verified: that a browser currently produces the pinned hash. The
browser tooling available while this was written cannot execute page script and does
not expose table cell text through its accessibility snapshot, so the viewer's hash
cannot be read. The structural claim - one implementation, imported by both paths -
holds and is enforced by a test; the byte-level cross-engine check, which is the
point of the pin, is outstanding. Recorded as a liability rather than glossed.


Not yet implemented, and printed as `not yet implemented` rather than `0`: ATE (Â§9.3),
live recombination *events* (Â§9.4 â€” the fusion maths is implemented and tested on
synthetic composites, but no agent pair exists to form a cluster), the volumetric
manifold, and the constrained manifold's scalar fields â€” the crawler can reach a pipe
but has no field to read once it is there.

## Commands

```bash
npm install
npm test                      # the suite
npm run typecheck
npm run dev                   # the viewer, at http://localhost:5173
npm run scenario -- s1        # the control condition, with detector IDs
npm run scenario -- s2        # the noise sweep
npm run scenario -- --report  # the full inspection report
npm run diag:map              # print the occupancy grid as ASCII
npm run diag:detect           # per-class detection metrics
npm run diag:market           # job market, regret, per-class recall
npm run diag:parity           # the headless reference the browser must match
npm run diag:lumen            # conduit geometry, bore classes, routing outcomes
npm run diag:inchworm         # what the crawler actually did, and whether it can
npm run diag:handoff          # escalations, and the confirmation rate (currently 0%)
npm run diag:regret           # S8 across 20 seeds: the kill condition
npm run diag:s9               # S9 across 30 seeds: the control arm and its break-even
npm run diag:math             # check the reimplemented transcendentals
```

## Using the viewer

Drag to orbit, wheel to zoom, click an agent or a finding to focus it. **Tab**
switches to a fly camera (WASD, Q/E for height, arrows to look). The panel carries
every metric with the detector ID that produced it, and the truth overlay is off by
default â€” when you turn it on, the panel says plainly that nothing in the report or
the metrics may use it.

## The five rules

**Nothing under `src/sim/` may import `three`, or touch a browser global.**
Both enforced by failing tests, because the failure is never someone ignoring the
rule â€” it is someone adding an import to save a line. The second half matters more
than it looks: one tsconfig types the package, so the viewer's needs force the DOM
lib on, which makes `performance.now()` *legal* in the sim. A simulation that can
read a clock has results that depend on the machine it ran on.

The viewer reads frames and writes nothing. Its undo is "rebuild the frame".

**No sensor or detector may reach the anomaly oracle.** Also a failing test, and
the highest-value one in the suite. If a detector can read the answer key then
every accuracy number is a tautology, every confidence is theatre, and the premise
of building a playpen rather than reading a spec sheet collapses. `report/` and
`world/fields.ts` are allowed â€” they are the evaluator and the world. **The job
system is under the same rule**, and for a sharper reason: a coordinator that reads
the oracle and announces a job per defect produces a swarm that has been told where
the defects are, and every accuracy number over it would still print.

**No detector may be silently dead.** Every registered detector must emit at least
one candidate over the control scenario unless it is declared silent with a reason
â€” and the guard checks that the declared ones still *are* silent, so the list
cannot rot. This is the precondition for trusting anything computed on top: an
auction's regret number over dead detectors looks like evidence and is not.

**The sim core uses only `+ - * /` and `Math.sqrt`.** IEEE-754 pins those
exactly. ECMAScript specifies `Math.sin`, `exp`, `log` and `pow` only as
*approximately* correct, so V8, SpiderMonkey and JavaScriptCore can each return a
different last bit â€” which means a run is bit-identical on your machine forever
and divergent on anyone else's, compounding through the pose graph, passing every
local test. `src/sim/math.ts` reimplements them with fixed iteration counts; a
grep test holds that line.

Determinism is asserted, not hoped for: two runs with the same seed must produce
the same event-log hash at the same tick, and a run must be unaffected by what ran
before it in the same process.

## The handoff works, and confirms nothing

The gate reads *"Inchworm findings hand off at a port and get confirmed."* Both halves
now run, and they have to be read together:

**Delivered:** lumen graph, 1-D locomotion, capability-limited entry, the 40 mm
irreversible case, graph-relational SLAM with loop closure, port routing, and the
escalation chain. The crawler spots a blockage with its range finder, publishes a
suspicion at confidence 0.40 - below the 0.60 acceptance threshold, because a range
finder bouncing off something cannot classify it - and a ground bot holding a thermal
sensor is dispatched to the port to sample the penetration. Every escalation in the
reference run is worked.

**The confirmation rate is 0%.** Structural, not a broken threshold:

- the corroboration test reads thermal candidates, and in-bore blockages are authored
  with `sourceStrength: 0` because an obstruction is geometry, not a heat source;
- the only other signal a blockage makes is stagnant air, and that is checked only at
  *air registers* - which conduit entries deliberately are not, since inferring
  "ventilation register" from "one side is ground" made the detector fire at a boiler
  flue one metre from a real blocked vent.

So: a suspicion can be raised, escalated and worked, but essentially never corroborated
from outside the pipe. The defect is 6.5 m away behind a sealed duct wall. A test
asserts the corroboration logic *can* confirm when the evidence is there, so the 0% is
known to be about the world rather than about the code.

Whether a conduit entry should count as a *partial* air register - a place where a
blockage does cause measurable stagnation - is recorded as an open question. The
answer must not be "raise the number".


## A note on false zeros

The recurring bug class in this project is a subsystem that produces **nothing** and
is indistinguishable from a building with nothing wrong in it. One detector ran for
an entire stage because its magnitude gate was 118 K; another reported a plausible
`0.00` because every wall in the house had zero surface observations. Metrics are
therefore printed as `not yet implemented` rather than `0`, and the report's
withheld-claims section exists for the same reason. A number that means "not
measured" must not look like a number that means "measured, and nothing there".

Stage E found the same shape somewhere new, and it is worth being precise about why
it is hard to catch. The crawler's landmark test re-fired every tick it sat beside a
node. It reported **2638 loop closures over 25 m of travel** and a drift rate of
`0.085 m per 10 m` with three significant figures â€” a number shaped exactly like a
measurement, made entirely of numerical noise. Meanwhile the crawler was pinned in a
1 m oscillation, so coverage read 10.7% of a 28 m conduit. Nothing anywhere looked
wrong, because every individual number was a real number.

The existing guard for this is scoped to detectors, and the inchworm raises no
detections at all â€” it has no thermal sensor â€” so the guard could not see it. The
defence that worked was writing tests that assert each metric **can fail**: null drift
when nothing was corrected rather than zero, closures bounded by visits rather than
ticks, and a drift rate that must come out below the uncorrected figure.

The purest instance of the class turned up later, and it was in the safety monitor.
`checkStuck` was exported, looked correct, and was **called from nowhere** â€” and the
value it was handed was a boolean rather than a count, so even a caller would have
passed `1` where it expected `200`. `stranded: 0` had been printed in every run since
Stage A and was measuring nothing at all. It was found because a field change
perturbed the trajectory into a 2500-tick freeze at an identical pose, coverage
dropped to 63.83%, and `stranded` still read 0. The monitor's silence was not evidence
of a healthy swarm; it was the absence of a monitor.

## Layout

```
src/sim/          the core. no engine types, no three, no Math.random, no clock.
  math.ts         transcendental replacements (see above)
  rng.ts          seeded PRNG
  eventlog.ts     typed events; the input to every metric
  world/          geometry, occupancy grid, fields, the oracle, content loading,
                  and the lumen graph (conduits, arc length, port routing)
  nav/            A*
  sensors/        depth, thermal, humidity/air, noise parameters
  sim/            ground bot, locomotion, calibration, detectors, recombination,
                  the inchworm and its graph-relational SLAM, the run loop
  jobs/           job schema, the contract-net auction, the coverage policy
  report/         association, per-class metrics, the report, the frame contract
src/view/        the viewer. the only importer of three.
src/content/      authored JSON, schema-validated at load
test/
  boundary/       sim/view boundary, DOM purity, oracle boundary, no-silent-detector guard
  determinism/    the transcendental ban, PRNG, replay, browser/headless parity pin
  math/           accuracy of the replacements
  world/          the constrained manifold: lumen graph, inchworm, SLAM, ports
  scenarios/      S1 control, S3 detection, S8 auction, coverage policy, recombination
scripts/          scenario runner and diagnostics
```
