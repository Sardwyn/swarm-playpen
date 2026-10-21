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

**And "reachable" has to mean two different things, because a 200 mm opening is a
hand-hole.** A *body* does not go through one — the shoulder is 400 mm and the hole
is 200. But an *arm* does, with a torch, and that is what a surveyor actually
does: kneel on the deck, put your hand and a light into the void, and feel around
for damp. So:

| | a body | an arm and a torch |
|---|---|---|
| a 200 mm hand-hole | **no** | **yes** |
| a 300 × 200 mm inspection hatch | **no** | **yes** |
| a 400 mm man-way | **yes** | yes |

The instrument's benchmark is the second column, not the first. A swarm that can do
what a person's arm can do is worth carrying onto a boat; a swarm that can only do
what a person can do by climbing in is worth nothing, because the person will
climb in.

That reframing is what the twin found by accident. The first version of this
domain claimed a person could get *through* a 200 mm hatch, which is false, and
the picture it produced — a person standing inside the void — was impossible. The
correct claim is smaller, and the product it implies is more achievable: **be the
arm, not the body.**

---

## 5. The fault taxonomy with observability

The core IP. One row per fault class. The right-hand columns are what makes it
worth more than the boat.

**This is now authored, not described.** The taxonomy lives in
`src/content/marine-taxonomy-01.json`, is loaded by
`src/sim/world/marine-taxonomy.ts`, and the twin's oracle references it. A table
in a document is a claim; a table in a content file that the code validates is a
constraint.

### 5.0 The distinction the whole thing turns on

A **signature** is a physical reading an instrument can produce. A **class** is a
cause — what a surveyor would write on the report.

| | |
|---|---|
| signature | `moisture_leak`, `thermal_anomaly`, `blocked_vent`, `clutter_hazard`, `structural_crack` |
| class | `active_water_ingress`, `condensation_in_void`, `exhaust_leak`, `blocked_drainage` |

The instrument produces signatures. A person produces causes. Five marine causes
share the `moisture_leak` reading and **no single measurement separates them**,
so the oracle names the cause *and* declares the reading, the engine matches on
the reading, and the report prints the cause with the reading beside it and
never claims to know which one it was.

This is not a hedge. It is the commercial argument. The product is a deployment
with a time series, not a handheld reading; the owner's next move after "a
moisture anomaly of undetermined cause" is to leave the logger there and wash
the deck. An instrument that names the cause from one reading is caught out by
the first marine engineer who looks at it.

| # | Fault — the cause | Reading — the signature | Spaces | Observable? | Second observable? | Corroborable? |
|---|---|---|---|---|---|---|
| **F1** | **Condensation in a void** | `moisture_leak` | all voids | **Yes** — RH + temperature | Temperature gradient, diurnal cycle | **Yes** — RH correlates with skin temp |
| **F2** | **Active water ingress / leak** | `moisture_leak` | voids, deck, hull | Yes — RH rise | Response to a wash cycle; point source | **Yes** — wash-cycle response is near-decisive |
| **F3** | **Core saturation (balsa topside)** | — | topsides, deck | Partly — capacitance, dual-depth | Hammer percussion (dull/hollow), UT | Yes, with percussion |
| **F4** | **Delamination / void in laminate** | — | deck, topsides | Partly | Thermography, UT, percussion | Yes, with two of three |
| **F5** | **Osmosis blistering** | — | below-waterline | Yes — blister count/size/pattern, fluid pH | Resistance/conductivity of fluid | Yes |
| **F6** | **Historic salt in core (osmosis precursor)** | `moisture_leak` | voids | **Indirect** — equilibrium RH with ambient | Chloride on sampling | Only with sampling |
| **F7** | **Fuel vapour in engine space** | — | engine bay, void | Yes — gas at the access point | Sensor + corroborating gas | **Yes** — and *nobody can go in* |
| **F8** | **Corrosion at dissimilar metals / fittings** | — | voids, engine bay | **No** — visual only | — | **No** — needs eyes |
| **F9a** | **Blocked ventilation / extraction** | `blocked_vent` | engine bay, voids | Partly — airflow, standing water | Standing water persists with pumps running | Yes |
| **F9b** | **Blocked drainage** | `blocked_vent`, `clutter_hazard` | deck, engine bay | Indirect | Standing water persists | Yes |
| **F10** | **Deck penetration leak (cleat, stanchion, winch, mast step)** | `moisture_leak` | deck | Yes — local RH at fixing, visual | Borescope | Yes |
| **F11** | **Unrecorded modification / penetration** | — | all | **No** — documentation | Surveyor record | **Yes** — this is Pan's problem exactly |
| **F12** | **Exhaust leak / water ingress to engine** | `thermal_anomaly` | engine bay | Yes — thermal, sound | — | Partly |
| **F13** | **Bilge high / pump fault** | `moisture_leak` | bilge | Indirect — depth | Standing water + pump state | Yes |
| **F14** | **Seacock / through-hull valve weeping** | `moisture_leak` | hull, garboard | Yes — visual, thermal | — | Partly |
| **F15** | **Machinery vibration / misalignment** | — | engine room | **No** — no detector for it yet | IMU + load correlation | Yes |
| **F16** | **Obstruction in a fuel line** | `blocked_vent` | engine bay, tank bay | Yes — the crawler's bore range finder | — | Partly |
| **F17** | **Weld defect or porosity** | `structural_crack` | hull, structure | Indirect — geometric proxy | UT, dye penetrant | Yes |
| **F18** | **Hull stress crack** | `structural_crack` | hull, structure | Indirect | UT mapping | Yes |
| **F19** | **Debris in the bilge** | `clutter_hazard` | bilge | Indirect | Depth + what is floating | Yes |

**A class with no reading is not a defect in the taxonomy.** F8, F11 and F15 are
in it with no signature attached, and the loader *refuses* to let a class marked
`not_observable` claim one. That is the point: corrosion at dissimilar metals
needs eyes and always will, an unrecorded penetration is a records problem, and
machinery vibration is a detector gap rather than a sensor gap — the crawler
already carries an accelerometer for its own state and nothing interprets it
yet. A product that writes its boundary down is a product that cannot be
surprised.

### 5.1 What the table says

- **F1, F2, F6, F13 are the void-accessible wins.** They are measurable in the
  spaces we can reach, they are measurable with cheap instruments, and they are
  the ones the industry cannot currently see.
- **F8 is the one nobody can do.** Corrosion needs eyes. That is a permanent limit of
  any instrument, and saying so is more valuable than a number that pretends
  otherwise.
- **F6 is only provable by sampling.** Honest answer: we can say "the void is in
  equilibrium with the atmosphere, which is consistent with hygroscopic salt rather
  than an active leak." We cannot say more without taking a sample.
- **F11 is a documentation check, not a measurement.** And it is worth real money.
- **F16 is the clearest case for the swarm earning its keep.** A 60 mm fuel line is
  a good place to put a robot and a bad place to put a person.

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
| `src/sim/world/yacht-sim.ts` | The single load path: the vessel, the oracle, the hull form, the assumptions. |
| `src/content/yacht-sim-01.json` | The vessel, in the house's own schema. Every assumption marked. |
| `src/content/yacht-sim-anomalies-01.json` | The oracle, with a reason for every miss. |
| `src/sim/report/take.ts` | A recorded run, coverage delta-encoded, so a scrubber replays it instantly. |
| `src/sim/report/verdict.ts` | A miss classified by cause: ARCHITECTURE or DETECTION. |
| `src/sim/report/frame.ts` | The frame contract, now including the volumetric coverage. |
| `src/view/hull.ts` | Hull geometry: shell, plating at the cut plane, profile curve, sheer line. |
| `src/view/yacht-scene.ts` | The scene. Ghost hull, coverage drawn into it, the unreachable volume dark and red, the machines with their trails, sensing cones and lock-on reticles. |
| `src/view/yacht-main.ts` | Run, record, replay. The playhead is continuous, so the camera and the machines move at the display rate and not at the record rate. |
| `src/view/yacht-director.ts` | The camera. A list of shots, and a shot either holds a position or locks onto a machine. Rate-limited, because a camera has inertia. |
| `src/view/yacht-console.ts` | The readout: agent cards, mission panel, event stream, findings, plan view, timeline. |
| `test/view/yacht-director.test.ts` | The two properties that make the motion read as cinema: the camera does not jump inside a shot, and a follow shot stays locked to its machine. |
| `index-yacht.html` | The page. `npm run dev`, then `/index-yacht.html`. |
| `scripts/diag-yacht-form.ts` | The inboard profile and the access arithmetic. `npm run diag:yacht`. |
| `scripts/diag-yacht-sim.ts` | The run, the findings, and the verdict. `npm run diag:yacht-sim`. |
| `test/world/yacht-domain.test.ts` | The claim, asserted. |
| `src/content/marine-taxonomy-01.json` | The marine fault taxonomy: the causes, the readings that stand behind them, what corroborates each, what it costs to fix, and what no instrument will ever see. |
| `src/sim/world/marine-taxonomy.ts` | The loader, and the validation that makes the taxonomy impossible to contradict itself. |
| `test/world/marine-taxonomy.test.ts` | The taxonomy's claims, asserted: 17 tests. |
| `test/world/domain-genericity.test.ts` | Renaming every fault changes nothing; a reading is only credited on its own manifold. |
| `scripts/diag-match.ts` | Why a finding matched the fault it matched: distance, extent overlap, manifold. |
| `scripts/diag-air.ts` | The air proxy at the engine bay vent, measured against the detector's gate. |
| `designs/yacht-brief.md` | The one-page brief for the people who can answer the question. Three minutes long, and it states what the instrument cannot do as well as what it can. |

**One content file.** The parallel regions model is gone. The vessel is a content
file in the house's own schema, the oracle is a separate file as it is for the house,
and the engine reads both through the same loaders. The scene and the diagnostic read
the same bytes through the same module, so the picture on screen and the profile in
the terminal are the same boat.

---

## 14. The result

```
engine room coverage 100.0%   4 found, 3 missed

  yc-01  exhaust_leak              sev 0.60  FOUND
  yc-02  blocked_ventilation       sev 0.50  DETECTION     nearest candidate 0.69 m
  yc-03  active_water_ingress      sev 0.75  FOUND
  yc-04  condensation_in_void      sev 0.85  ARCHITECTURE  nearest candidate 6.41 m
  yc-05  blocked_drainage          sev 0.40  FOUND
  yc-06  fuel_line_debris          sev 0.50  FOUND
  yc-07  salt_hygroscopic_equilibrium sev 0.70  DETECTION  nearest candidate 0.78 m
```

**The most severe fault on the vessel is in the forward stringer void, and the swarm
never gets near it.** The void is entered only through two 200 mm deck hatches; the
ground bot is 340 mm across, the hover bot is 240 mm across and needs a metre of
ceiling to hold station, and the inchworm is confined to conduits, of which the
void has none.

**And note what a person can do about it.** A 200 mm clear opening is a
*hand-hole*, not a man-way: nobody gets their body through one. What a person can
do is kneel on the deck, put an arm and a torch through it, and see and reach the
space inside — which is exactly what a surveyor does, and exactly what nothing in
this swarm can do. The ground bot is 340 mm across and cannot get its sensor
within 340 mm of a 200 mm hole.

The first version of this document said a person can get through a 200 mm hatch,
and the picture it produced put a person standing inside the void. Both were
false, and they were false in the same direction: the claim was inflated until
the picture could be drawn, and the picture then propped up the claim. The
correct claim is smaller and sharper, and it is the one the surveyor's own
practice is already built on.

**And the other two misses are not dressed up as coverage failures — and they are not
the same failure either.** The swarm was 0.69 m from the blocked vent and the
blocked-vent detector did not fire, because the air proxy at the port rises 118%
over the field's ambient and the detector's gate is a 150% rise. That is a
*calibration* finding: the entire field peaks below the threshold, so no position in
the engine bay would have triggered it. The third miss is the deckhead void over the
engine, which is 410 mm tall while the hover bot needs 1.0 m; it went in, spent its
whole 12 Wh pack holding station against the ceiling, and faulted on empty.

The distinction is the report. *The boat's architecture stopped the swarm* versus
*our detector is mis-calibrated* versus *our battery ran out*. One is the product;
the other two are bugs — and bugs we can fix, and now know where they are.

**The most severe fault on the vessel is in the forward stringer void, and the swarm
never gets near it.** The void is entered only through two 200 mm deck hatches; the
ground bot is 340 mm across, the hover bot is 240 mm across and needs a metre of
ceiling to hold station, and the inchworm is confined to conduits, of which the
void has none.

**And note what a person can do about it.** A 200 mm clear opening is a
*hand-hole*, not a man-way: nobody gets their body through one. What a person can
do is kneel on the deck, put an arm and a torch through it, and see and reach the
space inside — which is exactly what a surveyor does, and exactly what nothing in
this swarm can do. The ground bot is 340 mm across and cannot get its sensor
within 340 mm of a 200 mm hole.

The first version of this document said a person can get through a 200 mm hatch,
and the picture it produced put a person standing inside the void. Both were
false, and they were false in the same direction: the claim was inflated until
the picture could be drawn, and the picture then propped up the claim. The
correct claim is smaller and sharper, and it is the one the surveyor's own
practice is already built on.

**And the other two misses are not dressed up as coverage failures.** The swarm was
0.69 m and 0.78 m away from those faults and the detectors did not match them.
That is a detector limitation and it is reported as one.

The distinction is the report. *The boat's architecture stopped the swarm* versus *our
detector is imprecise.* One is the product; the other is a bug.

### What is authored and what falls out

Authored: the published principal characteristics, the profiles, the bulkheads, the
deck heights, the pipe routes, the hatch clear widths, the fault taxonomy, and the
magnitude of each fault.

Fell out of the geometry: the engine room's coverage, the four findings, the two
detection misses, the architectural miss, the distance from the swarm to the fault it
never found, and the fact that a person can put a hand into the space a robot
cannot reach at all.

Fell out of the taxonomy meeting the engine: the fact that the blocked-vent gate sits
above the whole range of the air field, and the fact that a humidity reading taken on
the sole is not evidence about the deckhead void above it. Neither was asked for.
Both are the reason to build the twin.

---

## 15. Bugs this round, and what they are about

| | |
|---|---|
| The topside parameter extrapolated past 1 when the cut plane was outboard of the sheer | The profile came out **13.44 m tall on a boat whose sheer is 4.16 m**. The cut plane leaves the hull forward of the forefoot and the function extrapolated instead of saying so. |
| The plating filled down to the baseline | On a deep-V hull that is most of the frame. The space under the hull is sea, not plating. |
| The diagnostic restricted the match to the ground manifold | That removed the volumetric faults from the pool, so the deckhead fault looked missed for a reason that was an artefact of the diagnostic. |
| An array literal whose arrow functions referenced the binding they were being destructured from | A temporal dead zone waiting to happen. |
| The report credited a finding to a fault on a **different manifold** | A humidity reading taken on the engine room sole was credited to a condensation in the deckhead void, 850 mm above it and two metres away, with no extent overlap at all. The report claimed a clearance it had not earned. |
| `IOU_MATCH` was declared in the spec and read by **nothing** | It was 0.3, and reading it would have rejected every detection in the run — including a crawler sitting 0.00 m from a fuel-line obstruction, whose extent overlap was 0.025. IoU measures delineation, not detection. |
| The physics was keyed on the fault's **name** | The field builder switched on `a.class === 'moisture_leak'`. Renaming that class to `active_water_ingress` stopped the humidity field being built at all, and recall fell by a third with nothing anywhere saying why. |
| The yacht's only clutter object was **inside the coolant tank** | So the clutter detector was silent, and the fault it was supposed to find had no physical object at all. A content file that misdescribes the world makes the report misdescribe it. |
| The viewer drew the hull in **boat coordinates** and the rooms in **simulation coordinates** | They are 1.75 m apart. The void's floor — which *is* the hull's inner surface — came out above its own ceiling, the void collapsed to a ribbon, and the fault the product is about was drawn underneath it, in the sea. The simulation was right; the picture was wrong, and wrong in the direction that flatters it. |
| The central claim was **false**, and the picture had been drawn to suit it | "A person can get through a 200 mm hatch" cannot be true — 200 mm is a hand-hole, an arm and a torch, not a body. And the scene had a person *standing inside* the void, which the geometry forbids. The claim had been inflated until the picture could be drawn, and the picture then propped up the claim. The corrected claim is smaller and sharper: a person's arm reaches the fault, and no robot can get its sensor within 340 mm of the hole. |

**The third one is the one worth remembering.** The diagnostic was not lying — it was
*answering a narrower question than it appeared to*, and the answer it produced was
indistinguishable from a real finding. A diagnostic that restricts the search space
produces false negatives that look exactly like results.

**But the last six are a different and worse shape.** They are all the same defect:
**something that looks like a measurement and is not one.** A declared threshold that
no code reads. A field that keys on a label rather than on physics. A content file
whose object is buried inside another object. A match gate that ignores which space
the sensor was in. A picture drawn in the wrong coordinate system. A claim that was
inflated until a picture could be drawn for it. Each of them produced a number — a
recall, a coverage, a clearance — and each of the numbers was wrong in a way that
pointed the wrong way.

The generalisation worth keeping: **a name that can move a number is doing physics,
a parameter that no code reads is not a parameter, and a picture that is drawn to
support a claim is not evidence for it.** The test that catches the first is
`test/world/domain-genericity.test.ts`: rename every fault in the domain to a
nonsense string, keep the reading, and assert the run is byte-identical. The test
that catches the third is in `test/world/yacht-domain.test.ts`: assert the fault is
above the floor the renderer draws and below the deck, and that it is within an
arm's reach of the hole. If a name can move a number, or the picture can drift away
from the space, those tests fail — and neither needs anyone to remember to look at
the recall.

---

## 16. Relationship to the other work

The same instrument, three domains:

| Domain | What it measures | Status |
|---|---|---|
| Building inspection (the swarm) | spatial recognition, anomaly detection, manifold heterogeneity | built - 425 tests |
| Yacht condition | void state, corrosion precursors, coverage of what is unreachable | built - this document |
| Maritime digital twin (Thales route) | fault traceability, corroboration in low-connectivity | drafted - `thales-application.md` |

And the through-line across the whole portfolio, which is the same in every case:

> **Make the invisible legible, with stated coverage and reproducible evidence.**

The maths trainer finds your weakest axiom and names it. The scanner says what it did
and did not examine. The swarm turns detection accuracy into a number. The yacht
report says which voids were wet, which were not, and which nobody could reach.

**That is one method applied four times. The generic harness is what makes the fifth
domain cheap.**
