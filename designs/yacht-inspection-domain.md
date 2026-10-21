# Yacht inspection domain — Sunseeker MY, midrange

**Status:** designing. Pre-production. Nothing built.
**Supersedes:** nothing.
**Companion documents:** `swarm-simulation-spec.md`, `adr-001-sim-view-boundary.md`,
`thales-application.md` (the same method aimed at a different domain — see §13).

---

## 0. What this document is

The swarm is a deterministic measurement instrument for a space: it maps, it detects,
and — the part that matters — **it states what it examined and what it could not, and
it proves those claims are reproducible.**

This document specifies the yacht domain for that instrument. It answers four
questions:

1. What is the space, on this class of vessel?
2. What can go wrong in it, and what can actually be *observed*?
3. What does the instrument measure, and how does it decide between the causes of a
   reading?
4. What is the first thing we can actually build and sell?

It does not specify hardware. It specifies the **fault taxonomy with an observability
column**, and that table is the intellectual property.

---

## 1. Why this domain, and why now

Three facts about how yacht condition is assessed today, each of which is an opening.

**1.1 The instrument does not measure what it is assumed to measure.**

> "The first thing to know about moisture meters is that they don't actually measure
> moisture. They measure conductivity… these instruments do not read a water
> percentage. They read the material's electrical behaviour, its dielectric
> response."
> — Gerr Marine, *Limitations and Use of an Important Tool*

> "A moisture meter is not a diagnostic instrument on its own. It is a very good
> screening tool."

> "If you ever read a survey report that condemns a hull (or gives it a totally clean
> bill of health) based on moisture meter readings alone, **be suspicious**."
> — Gerr Marine

**1.2 The reading is a function of the operator, not only the hull.**

> "A test done by the University of Rhode Island… showed a Sovereign meter A scale
> varied as much as reading 5.5 with light pressure to 11 with hard pressure on a
> water-saturated fiberglass panel."

> "A reading of '20' could be quite good or quite bad, depending on which meter was
> used and on which scale." (Tramex 0–30 / 0–100; Sovereign 0–25 / 0–100.)

> "Most marine surveyors employ moisture meters, and it certainly can appear to add
> weight to a report to record, say, that: 'The forward port hull bottom reads 18 on
> the scale…' In fact, you should always specify the make and model of the meter, and
> the scale used for the reading in your report." — *not always done.*

**1.3 Nothing is time-resolved, and early treatment is counter-productive.**

> "Early treatment of blistering tends to be less successful than treatment of vessels
> with more advanced problems… breakdown reactions in GRP laminates take some time to
> reach their conclusion; and if treatment is carried out prematurely, it is much more
> difficult to remove reactive or hygroscopic compounds from the laminate, with the
> result that a recurrence of the blistering is much more likely to occur."

> "Moisture meters measure only the surface moisture… the moisture meter is only going
> to tell you what you already know; it's wet. **It cannot tell you anything about the
> propensity of a hull to blister.**"

So the industry measures an *instant* of a *proxy* for a *rate*. That is the gap.

---

## 2. Target vessel

**Class:** Sunseeker motor yacht, midrange — the Predator / Manhattan / Superhawk
family, 46–56 ft (14–17 m).

**The exact model must be fixed with Otto Mukahanana before modelling starts.**
Several variants differ in ways that matter (single-level main deck vs lower-deck
saloon; garage vs beach club; IPS pods vs shafts; deck vs cockpit sole access to the
engine space). Modelled against a class rather than a hull is how the observability
table ends up being generic and useless.

### 2.1 Construction facts (verified from Sunseeker published specification)

From the Sunseeker Predator 80 standard specification, which states construction for
the MY range:

| | |
|---|---|
| Hull | Hand-laid GRP |
| Skin | Gel coat, **vinylester skin coat with powderbound mat** |
| Bottom | Stitched multi-axial reinforced single-skin |
| **Topsides** | **Balsa-cored** |
| **Deck and superstructure** | **PVC foam-cored** |
| **Structure** | **"Hull stiffened with longitudinal stringers supported by transverse bulkheads and floors"** |
| Access | "Engine room access hatch" in the aft cockpit |
| Fuel | Emergency fuel shut-off valves to main engines and generators, **located on tank hatch**, remotely actuated from the fire control locker with local manual override |

Reference examples in class: Predator 55 — 17.14 m, twin Volvo Penta IPS 950, engine
room accessed through a hatch in the cockpit. Manhattan 55 — 17.21 m, three cabins,
flybridge, aft beach club. Camargue 50 — 16.3 m, GRP throughout, 2 × 1000 L fuel
tanks outboard of the main engines.

**Consequences worth stating, because they set the risk picture:**

- **Balsa-cored topsides and PVC foam-cored decks are the rot-prone assemblies.**
  Balsa can hold over 90 % moisture when fully degraded; foam-cored is the same
  problem with a different material.
- **Vinylester skin coat on the bottom** is why osmosis is *less* common on newer
  boats. The industry says so. So the below-waterline hull of a midrange Sunseeker is
  relatively well protected, and the risk has moved **upward** — to the balsa-cored
  topsides and the foam-cored deck.
- **That inverts the industry's search pattern.** Surveyors concentrate on the
  underwater hull and blisters. But on balsa- or plywood-cored decks:
  > "the first places to look are cleats, stanchion bases, winches and the mast step."
- **The stringers and transverse bulkheads create the enclosed voids.** This is the
  single most important structural fact for this project: the voids are *by
  construction*, and they run the length of the boat.

---

## 3. The space model — three manifolds on this boat

The swarm's three manifolds map onto a midrange MY more cleanly than they map onto
the building the swarm was written for.

### 3.1 Ground manifold — walkable, flat, lit

Engine room sole · lazarette / garage sole · cockpit sole · forward cabin sole and
locker sole · lower-deck saloon and galley sole · bathing platform · foredeck.

**Sensors:** depth/probe (standing-water depth in the engine room bilge and lazarette),
thermal, humidity (interior RH as a *reference* baseline for the voids), gas.

### 3.2 Constrained manifold — enclosed, inaccessible, where the water is

**The stringer voids.** Between adjacent longitudinal stringers, bounded by the hull
skin, the deck, and transverse bulkheads or floors. On this class these are the
largest continuous volumes on the boat and they are **enclosed by the moulding** — the
hull and deck are closed GRP shells bonded together.

| Void | Why it matters | Access |
|---|---|---|
| **Stringer void, port, fwd** | Balsa-cored topside adjacent; sun-facing side heats | Inspection hatch? **Unknown — see §11** |
| **Stringer void, stbd, fwd** | As above, cooler side | As above |
| **Stringer void, port, aft** | Nearest the fuel tanks and engine bay | As above |
| **Stringer void, stbd, aft** | As above | As above |
| **Deckhead void** | Between deckhead liner and the deck above. Largest single void on many layouts | Often none |
| **Engine bay void** | Between engine bay bulkhead and the hull. **Fuel vapour hazard.** Warm | Engine room hatch |
| **Fuel tank surrounds** | Tanks outboard of the main engines on some models; bonded on others — **confirm** | Tank hatch |
| **Bilge / garboard** | Under the floor, often wet, often oily | Bilge pump, hull access |
| **Bunk / locker voids** | Small, awkward, frequently forgotten | Hatch or none |

**This is the manifold the swarm's constrained agent was written for, and it is
bigger here than in the building.** The inchworm's premise — *a space you can enter
but cannot see out of, reached through a port, with sensors that cannot corroborate
each other* — describes a stringer void precisely.

### 3.3 Volumetric manifold — overhead, around machinery

Above the engine room deckhead (pipework, exhaust routing, overhead tanks) · under the
cockpit sole over the engine bay · the deckhead void above the lower deck · around the
helm console and electronics lockers.

---

## 4. The access model — and the one question that could sink it

Everything above assumes a void can be opened. **On a GRP boat it may not be.**

A closed GRP hull is a moulding; the voids are the space *between* mouldings, and
there is no reason for a builder to have cut access into them. Where access exists it
is typically a small inspection hatch (commonly 150 × 150 mm to 300 × 200 mm), and
on this class the engine room hatch and the cockpit engine hatches are the main ones.

Three possible worlds, and they lead to different products:

| World | Reality | Product |
|---|---|---|
| **A. Voids are openable** | Inspection hatches exist and voids are reachable | The full plan: void logger + crawler + handheld. §10 |
| **B. Voids are sealed but bounded** | No access, but the void is bounded by structure we can sense from inside | **Indirect measurement**: interior humidity and thermal imaging of the hull skin from the accommodation side, plus vapour sampling at seams. §10.3 |
| **C. Voids are sealed and unbounded** | No access, no bounded volume | **Only the accessible spaces.** The product becomes the coverage statement and the hull-side measurement, and the void problem is honestly reported as out of scope |

World B is more likely than A for a production GRP boat and is not a failure — it is a
different and cheaper product. World C is possible for a low-cost build and would
mean the void thesis is dead for this class.

**This is question 1 for Otto (§11). It decides everything else.**

---

## 5. The fault taxonomy with observability

The core IP. One row per fault class. The right-hand columns are what makes it
worth more than the boat.

| # | Fault | Spaces | Observable? | Second observable? | Corroborable? |
|---|---|---|---|---|---|
| **F1** | **Condensation in a void** | all voids | **Yes** — RH + temperature | Temperature gradient, diurnal cycle | **Yes** — RH correlates with skin temp |
| **F2** | **Active water ingress / leak** | voids, deck, hull | Yes — RH rise | Response to a wash cycle; point source | **Yes** — wash-cycle response is near-decisive |
| **F3** | **Core saturation (balsa topside)** | topsides, deck | Partly — capacitance, dual-depth | Hammer percussion (dull/hollow), UT | Yes, with percussion |
| **F4** | **Delamination / void in laminate** | deck, topsides | Partly | Thermography, UT, percussion | Yes, with two of three |
| **F5** | **Osmosis blistering** | below-waterline | Yes — blister count/size/pattern, fluid pH | Resistance/conductivity of fluid | Yes |
| **F6** | **Historic salt in core (osmosis precursor)** | voids | **Indirect** — equilibrium RH with ambient | Chloride on sampling | Only with sampling |
| **F7** | **Fuel vapour in engine space** | engine bay, void | Yes — gas at the access point | Sensor + corroborating gas | **Yes** — and *nobody can go in* |
| **F8** | **Corrosion at dissimilar metals / fittings** | voids, engine bay | Partly — visual only | — | **No** — needs eyes |
| **F9** | **Blocked ventilation / drainage / bilge pump** | engine bay, voids | Partly — airflow, standing water | Standing water persists with pumps running | Yes |
| **F10** | **Deck penetration leak (cleat, stanchion, winch, mast step)** | deck | Yes — local RH at fixing, visual | Borescope | Yes |
| **F11** | **Unrecorded modification / penetration** | all | **Yes** — config vs. documentation | Surveyor record | **Yes** — this is Pan's problem exactly |
| **F12** | **Exhaust leak / water ingress to engine** | engine bay | Yes — thermal, sound | — | Partly |
| **F13** | **Bilge high / pump fault** | bilge | Yes — depth | Standing water + pump state | Yes |
| **F14** | **Seacock / through-hull valve weeping** | hull, garboard | Yes — visual, thermal | — | Partly |
| **F15** | **Machinery vibration / misalignment** | engine room | Yes — IMU | Load correlation | Yes |

### 5.1 What the table says

- **F1, F2, F7, F13 are the void-accessible wins.** They are measurable in the
  spaces we can reach, they are measurable with cheap instruments, and they are the
  ones the industry cannot currently see.
- **F8 is the one nobody can do.** Corrosion needs eyes. That is a permanent limit of
  any instrument, and saying so is more valuable than a number that pretends
  otherwise.
- **F6 is only provable by sampling.** Honest answer: we can say "the void is in
  equilibrium with the atmosphere, which is consistent with hygroscopic salt rather
  than an active leak." We cannot say more without taking a sample.
- **F11 is a documentation check, not a measurement.** And it is worth real money.

### 5.2 The corroboration problem, stated precisely

A high humidity reading in a void has at least four causes, and they need different
responses:

| Cause | Humidity | Temperature | Time response | Distinguishing evidence |
|---|---|---|---|---|
| Active leak | high, local gradient | near ambient | **rises after a wash cycle** | wash-cycle response |
| Condensation | high, tracks cold surfaces | **correlates with skin temp** | diurnal, sun-driven | RH–temperature correlation |
| Historic salt | high, **in equilibrium with ambient** | near ambient | follows ambient, not the boat | equilibrium test |
| Artefact / dead sensor | anything | — | uncorrelated | sensor self-diagnostic |

**No single instrument separates these. A time series does.** This is why the
instrument needs to *stay* — it is not a handheld reading, it is a deployment.

---

## 6. Sensor → instrument mapping

| Swarm sensor | Instrument | What it actually gives | Cost |
|---|---|---|---|
| humidity | **RH + temperature logger** (e.g. SHT-series + MCU, or EL-USB) | Time series in a void. The MVP instrument | £40–150 |
| thermal | IR thermometer / thermal camera | Surface temperature, and the skin-side proxy for a void's state | £60–2,000 |
| air / VOC | **Combustible gas (Lel detector) + photoionisation** | Whether a person may enter. The safety gate | £80–400 |
| depth (ToF) | Ultrasonic / probe rod | Standing water depth, gap measurement | £15–60 |
| IMU | Accelerometer | Machinery vibration; also *the crawler's own state* | £5–40 |
| — | **Capacitance moisture meter** | The industry's instrument. We *consume* it, not replace it | £400–2,000 |
| — | **Ultrasonic thickness gauge** | Corroborates F3, F4 | £1,500+ |
| — | **Borescope** | Corroborates F10; visual F8 | £300–3,000 |

**Note the strategy.** We do not replace the moisture meter. We *fix* it: we make the
reading reproducible, we say what it means, and we say what it does not cover.

---

## 7. The coverage-and-corroboration report

The deliverable is a **document**, and its shape is the differentiator.

A conventional survey report says: *"the forward port hull bottom reads 18 on the
scale."* It does not say which meter, which scale, who pressed how hard, what the
baseline was, how many points were taken, or what was not looked at.

Ours states, per space:

```
SPACE: port stringer void, forward
  ACCESS: inspection hatch 200x150, cockpit sole, port
  VOLUME EXAMINED: 100% of the bounded void (14.2 m³)
  SENSORS DEPLOYED: RH+T logger, 2026-10-28 → 2026-12-09 (6 weeks, one wash cycle)
  READING: RH 71–93% mean 84%, oscillating ±9% with skin temperature
  INTERPRETATION: F1 condensation (RH–temperature correlation r = 0.86).
                   F2 active leak EXCLUDED (no response to wash cycle).
  CONFIDENCE: coverage 1.00 × corroboration 1.00 = 1.00
  COVERAGE BASIS: 2 observations agree (RH, temperature response); 1 disagrees (no wash response)
  NOT EXAMINED: aft half of this void, 2.1 m³, no access point — contractor to cut
  WITHHELD: whether core saturation has occurred (no percussion, no UT)
```

That structure is the swarm's existing report layer, unchanged: **coverage mandatory,
withheld claims stated, every claim carrying a detector ID, byte-identical on replay.**

---

## 8. The MVP — and it is not a robot

**Stage 1: void logger + handheld kit. No robotics. No hull. Almost no capital.**

1. **A void logger.** RH + temperature, battery, 6–12 weeks, deployed through the
   engine room hatch and cockpit engine hatches. Retrieve, read, plot.
2. **A handheld kit** for the accessible spaces: RH+T, IR, gas detector, probe rod.
3. **The report layer**, reusing `src/sim/report/*` unchanged, with a new adapter for
   the yacht domain.

**What it produces that the industry cannot:**
- A **time series** in spaces nobody measures (§1.3)
- A **distinction between condensation and leak** (§5.2), which decides whether you
  dry it or repair it
- A **coverage statement** (§7), which is what a report needs to be admissible in a
  negotiation or a claim

**Cost:** ~£300 of hardware per vessel. **Time:** one deployment, one retrieval.
**Who does it:** the engineer, on the boat, in an afternoon.

### 8.1 Why the logger is the right first product

- It is cheap enough to leave on a boat for a season and lose
- It produces the one thing the industry cannot get: a **rate**
- It finds the voids a person cannot enter, at zero risk, at zero effort
- Its output is a *chart*, and charts sell

### 8.2 Why it is also the robot's business case

The logger's output says: *"this void is wet, this one is dry, this one has a leak."*
The robot's job is then unambiguous: **go where the logger says there is a problem
and a person cannot go.** And the gas detector at the access point says whether a
person *can* go. That is not a robotics programme; that is a work order.

---

## 9. The platform ladder

| Stage | Platform | Access | Capital | Gate |
|---|---|---|---|---|
| **0** | **Yacht-domain twin** (§10) | simulation | none | Observability table produced and reviewed |
| **1** | **Void logger + handheld kit** | engine room, compartments, access ports | ~£300/vessel | A real void measured with a real time series |
| **2** | **Drone** | deck, superstructure, topsides | low | Exterior coverage added |
| **3** | **Crawler** | stringer voids, engine bay void, deckhead void | high | Only if Stage 1 proves a void problem exists *and* is reachable |

**Stage 3 is conditional and may never happen.** World B or C in §4 kills it. That is
acceptable: Stage 1 alone is a sellable product with a defensible claim.

---

## 10. Stage 0 — the yacht-domain twin

The swarm, re-domained. Its job is to produce the §5 table with **measured** numbers
rather than asserted ones, in a domain where the ground truth is known by construction.

### 10.1 What changes

| Swarm | Yacht |
|---|---|
| Rooms, doors, walls (`world/geometry.ts`) | Compartments, bulkheads, hatches, engine bay bulkhead, hull skin |
| Conduits, ports (`world/lumen.ts`, `world/bore.ts`) | Stringer voids, deckhead void, engine bay void, duct runs |
| Attic / ceiling void (`world/volumetric.ts`) | Deckhead void, engine room overhead |
| 21 building anomalies (`content/anomalies-01.json`) | The F1–F15 maritime taxonomy |
| Ground/inchworm/hover | Handheld / crawler / drone |

### 10.2 What does not change

**Everything in the harness** — `eventlog.ts`, `math.ts`, `rng.ts`, `report/*`,
`jobs/schema.ts`, `sensors/noise.ts`, `view/*`, and the boundary and determinism
tests. The oracle boundary, the no-silent-detector guard, coverage-multiplied
confidence, byte-identical replay, the trajectory-conditioned recall: **all of it
carries over unchanged.** That is the point of the two-layer structure.

### 10.3 The twin must be able to run in World B

If voids are sealed, the twin still works — and it is where World B is *designed*:
interior RH and skin-side thermography are the only observables, and the twin's job
is to quantify what they can and cannot resolve. **That is a publishable result even
with no hardware at all.**

### 10.4 The oracle

For the yacht domain, ground truth is the **surveyor's finding** — from Otto, or from
an independent surveyor. The boundary is unchanged and now has teeth:

> The detector may not see the surveyor's conclusion. The instrument is scored
> against it afterwards.

This is the single most important property of the whole project, and it is the same
property that made the swarm's own numbers mean anything.

---

## 11. Open questions for Otto Mukahanana

Ordered by leverage. **Q1 and Q2 decide the product; the rest fill it in.**

**Q1 — Access.** On a midrange MY of this class: which stringer voids have an
inspection hatch, where, and what size? Is the deckhead void accessible at all? Are
the voids between mouldings sealed? *This decides World A / B / C (§4).*

**Q2 — The fault taxonomy.** What actually goes wrong on these boats, in what
spaces, ranked by what it costs the owner? Which of the F1–F15 classes have you
actually found? Which have you *almost* found and could not?

**Q3 — Seasonality.** When does condensation peak? Which months produce a wash
response, and how long after a wash does a void dry? *This sets the deployment
window and the length of the time series.*

**Q4 — A vessel.** One boat, one season, access granted for a deployment.

**Q5 — The deck.** Where do balsa-cored topsides and foam-cored decks actually
delaminate on this class? Is it the cleat and stanchion pattern you would expect, or
something specific to the tooling?

**Q6 — Access and safety.** Who may go into the engine space, and under what gas
conditions? Who may cut a hole in a GRP hull, and what is the process? *A hole cut
for access is itself a defect, and we must not create the problem we are measuring.*

**Q7 — The survey market.** Who does you use for pre-purchase surveys? What do they
charge, what do they deliver, and what do you wish they had done? *This is our
competitor, our channel, and our first design partner.*

---

## 12. What must not be assumed

| Do not assume | Why |
|---|---|
| That a high humidity reading means a defect | It means a reading. §5.2. |
| That capacitance readings are comparable across meters | They are not. §1.2. |
| That void state can be inferred from the hull surface | The hull reading is downstream of the void by weeks to months. |
| That "no moisture found" means "no moisture" | Say what was examined and what was not. §7. |
| That corrosion can be detected without eyes | F8. |
| That a boat's structure is the same across the class | Modelled against one hull. §2. |
| That we may cut into a hull | Ask first. Q6. |
| That a surveyor's finding is the ground truth | It is *a* reference. The instrument is scored against it, not tuned to it. |

---

## 13. Where this lives

| | |
|---|---|
| `src/sim/world/yacht-form.ts` | Parametric hull. Keel lift, beam plan, freeboard, deadrise, chine ratio over eleven stations. The section is keel + chine + sheer. |
| `src/sim/world/yacht.ts` | Regions, hatches, the access graph, and the person/crawler reachability sets. |
| `src/sim/world/yacht-content.ts` | The single load path for the content, shared by the diagnostic and the browser. |
| `src/content/yacht-01.json` | The vessel. Every assumption marked. |
| `src/view/hull.ts` | Hull geometry: shell, plating at the cut plane, profile curve, sheer line. |
| `src/view/yacht-scene.ts` | The scene. Ghost hull, void volumes, access rings, fault beacons with drop lines to the plating. |
| `src/view/yacht-main.ts` | Entry point, panel, camera. |
| `index-yacht.html` | The page. `npm run dev`, then `/index-yacht.html`. |
| `scripts/diag-yacht-form.ts` | The ASCII inboard profile, the access graph, the sensitivity sweep, and the content-defect pass. `npm run diag:yacht`. |
| `test/world/yacht-domain.test.ts` | 18 tests. |

**The scene and the diagnostic read the same content through the same module**, so
the picture on screen and the profile in the terminal are the same boat. A
diagnostic that reads the file and a scene that imports it can drift, and the drift
is invisible until somebody puts the two side by side.

**Two bugs the render found that the diagnostic did not**, both of the same class as
the ones already in this project:

- the topside parameter was extrapolated past 1 when the cut plane was outboard of
  the sheer, and the profile came out **13.44 m tall on a boat whose sheer is
  4.16 m**. The cut plane leaves the hull forward of the forefoot, and the function
  extrapolated instead of saying so.
- the plating was filled down to the baseline, which on a deep-V hull is most of
  the frame. The space under the hull is sea, not plating.

Both are now tests. A geometry bug that only shows up in a render is a bug that
survives until somebody looks at the render.

---

## 14. Relationship to the other work

The same instrument, three domains:

| Domain | What it measures | Status |
|---|---|---|
| Building inspection (the swarm) | spatial recognition, anomaly detection, manifold heterogeneity | built — 425 tests |
| Yacht condition | void state, corrosion precursors, coverage of what is unreachable | §0–§10, this document |
| Maritime digital twin (Thales route) | fault traceability, corroboration in low-connectivity | drafted — `thales-application.md` |

And the through-line across the whole portfolio, which is the same in every case:

> **Make the invisible legible, with stated coverage and reproducible evidence.**

The maths trainer finds your weakest axiom and names it. The scanner says what it did
and did not examine. The swarm turns detection accuracy into a number. The yacht
report says which voids were wet, which were not, and which nobody could reach.

**That is one method applied four times. The generic harness is what makes the fifth
domain cheap.**
