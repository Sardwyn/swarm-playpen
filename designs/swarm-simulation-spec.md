# Swarm Inspection Playpen — simulation spec

**Status:** designing
**Date:** 2026-10-01
**Input:** a hand-off brief defining a virtual "playpen" for a three-agent indoor
inspection swarm, to validate multi-manifold locomotion, distributed SLAM, job
allocation, recombination, anomaly detection, shared mapping and inspection
reporting without hardware.
**Supersedes:** nothing.
**Amends:** nothing. Related to `designs/MEGA-F-UP-GDD.md` §20 (sim core doctrine)
and `mil/designs/adr-001-event-log-and-llm-boundary.md` (typed event log and the
deterministic-detector boundary), both of which this document adopts rather than
re-argues.

---

## 0. What this is, and the bet

A deterministic, headless simulation of three inspection robots in one house,
plus a browser viewer that lets you fly a camera through the result and read the
metrics that the run produced.

**Thesis: the swarm is only worth having if the three robots are worse than one
robot at most things and better at exactly one thing — recombination.** Any
inspection system can be built from three specialised robots. What cannot be
replaced by three robots working in parallel is the case where no single robot
can both *reach* and *see* the same defect.

So the bet is named and it is testable:

> **A defect exists that no single agent can both reach and observe. The
> recombination case is what pays for the complexity of a heterogeneous swarm.**

`test-scenarios.md` §S9 is that test. If a heterogeneous three-bot swarm does not
beat an equivalent-cost homogeneous swarm on S9, the playpen has told us the
architecture is wrong, and that is a finding, not a bug.

**Why a simulation and not hardware.** Four reasons, in order of weight:

1. **Ground truth.** Real inspection cannot tell you what it missed. The sim can,
   because the anomaly field is authored and hidden from the agents. That is what
   makes "detection accuracy" a number instead of an opinion.
2. **Repetition.** Locomotion, allocation and fusion failures are rare events.
   A thousand runs is a weekend here and a year of hardware.
3. **Determinism.** A run replays exactly, so a metric regression has a cause.
4. **Cost.** No robots, no site, no insurance.

**Explicitly not the goal:** a pretty robot sim, a physics showcase, or a
competence at searching buildings. If the numbers do not move, the playpen has
failed even if the viewer looks good.

---

## 1. Simulation architecture

### 1.1 Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | **TypeScript, strict** | Toolchain already in this repo (`mil/`) |
| Sim core | **Plain TS, no engine types** | The single most important rule in this document |
| Viewer | **Three.js + Vite** | Real 3D camera, orbit and fly, in a browser |
| Tests | **Vitest** | Already configured; headless runs at 10,000× |
| Content | **JSON, schema-validated at load by a test** | Same rule as `mil/` §8 and MEGA F UP §22 |
| Docs | **Markdown, this repo's `designs/` convention** | |

Rejected: Unity, Unreal, Godot — install cost and iteration loop are wrong for a
harness whose entire purpose is to be run a thousand times. PyGame — cannot
satisfy "I must be able to interrogate the system visually" with a 3D camera.

### 1.2 The boundary

> **Nothing under `swarm/src/sim/` may import `three`. Enforced by a test.**

The test greps the import graph of `sim/` and fails the build on a hit. This is
not style: if the sim can reach the viewer, then a rendering bug can become a
simulation bug, and a run stops being reproducible. The same rule is
MEGA F UP §20.1 and MIL ADR-001's "the engine decides, the model interprets",
wearing different clothes.

The converse direction is allowed and encouraged: the viewer reads a sim frame
and never writes sim state. All state changes go through commands.

### 1.3 Module map

```
swarm/
  designs/
    swarm-simulation-spec.md      this document
    adr-001-sim-view-boundary.md  the boundary + determinism guarantee
    test-scenarios.md             the scenario matrix and pass criteria
  src/
    sim/                          engine-agnostic core
      rng.ts                      seeded PRNG; the only source of randomness
      tick.ts                     fixed 10 Hz step, stable-ID iteration
      eventlog.ts                 typed events; primary structure
      types.ts                    shared value types (no class, no engine)
      world/
        geometry.ts               rooms, walls, furniture, appliances
        manifolds.ts              ground / constrained / volumetric
        fields.ts                 temperature, moisture, air  (GROUND TRUTH)
        anomalies.ts              authored labels + extent + severity
        ports.ts                  manifold connectors
      sim/
        agents.ts                 per-agent kinematic state
        locomotion.ts             three locomotion models
        power.ts                  per-agent energy ledger
        auction.ts                job allocation
        cluster.ts                recombination
        fusion.ts                 shared global map
        detectors.ts              deterministic metric detectors
      sensors/
        depth.ts thermal.ts scalar.ts imu.ts noise.ts
      slam/
        keyframe.ts scanmatch.ts loopclosure.ts posegraph.ts
      jobs/
        schema.ts market.ts
      report/
        metrics.ts report.ts
    view/                         Three.js. Reads frames. Writes nothing.
      viewer.ts scene.ts frames.ts
  content/
    house-01.json                 the environment, authored
    anomalies-01.json             the hidden oracle
  test/
```

### 1.4 Determinism

> **Given the same seed and the same input stream, the sim produces a
> bit-identical state at tick N.**

Inherited from MEGA F UP §20.2, with one addition that JavaScript forces and C#
did not:

**The sim core uses only `+ - * /` and `Math.sqrt`.** IEEE-754 specifies those
exactly, so they are bit-identical across engines. `Math.sin`, `Math.cos`,
`Math.exp`, `Math.log` and `Math.pow` are *implementation-defined* in ECMAScript
— V8, SpiderMonkey and JavaScriptCore may each return a different last bit. A
single `Math.sin` in a heading update silently destroys cross-machine
reproducibility while leaving same-machine reproducibility intact, which is the
worst possible failure mode: it passes locally forever.

Therefore: angles are integrated with a rational approximation in `sim/math.ts`,
and every exponential and logarithm in the diffusion and noise models is a
series expansion with a bounded iteration count. Tested by
`test/determinism/transcendental.test.ts`, which greps `sim/` for the banned
identifiers. A seeded PRNG must never fall back to `Math.random`.

Other inherited rules: iterate by stable ID, never by hash or insertion order;
fixed 10 Hz tick; no `Date.now()` anywhere in `sim/`; the tick accepts injected
time, never reads a clock.

### 1.5 The typed event log

Adopted wholesale from MIL ADR-001 §1.2, because the reasoning transfers
exactly. Endpoint state hides trajectory; the trajectory is what is diagnostic.

Every meaningful thing that happens becomes a typed, timestamped event:
`sensor.observation`, `keyframe.created`, `loop.closed`, `job.announced`,
`bid.submitted`, `job.awarded`, `job.handed_off`, `cluster.formed`,
`cluster.dissolved`, `anomaly.candidate`, `fusion.constraint_added`,
`agent.battery_critical`, `agent.stranded`.

Then:

```
  sim → typed event log → deterministic detectors → claims + detector IDs
                                                              ↓
                                                  prose / report narrative
```

**Rules:** the event log is a primary structure, not a debug byproduct — it is
the input to the metrics, and metrics cannot be computed any other way. Every
number in §9 has at least one detector ID that produces it. Prose may only
phrase detector claims and must cite the ID. When no detector fired, the report
says "no anomaly detected to the confidence the available evidence supports" and
names the coverage shortfall — it never guesses.

This is why the report can be trusted: **every sentence in it is either a
measurement or is a measurement with a detector's name on it.**

---

## 2. Environment

One house, `content/house-01.json`, authored to be a hard inspection problem
rather than a floor plan. Target footprint 12 m × 8 m over two storeys plus an
attic void.

### 2.1 Ground manifold

| Space | Purpose in the sim |
| --- | --- |
| Hall, living room, kitchen, bathroom, utility | Navigation and coverage |
| Corridor, 6 m, with a dog-leg | Loop closure; the long-traversal drift test |
| Under-furniture voids (3) | Forces a low-clearance chassis decision (§12) |
| Appliances: fridge, washing machine, boiler | Job targets, thermal sources, ports |

Clearance profile: the ground bot is modelled at **0.11 m body height, 0.34 m
turning radius**. It passes under the sofa and the low shelving unit and not
under the kitchen units. This is a deliberate constraint, not a limitation to
route around: a robot that fits everywhere has no interesting allocation problem.

### 2.2 Constrained manifold

| Conduit | Bore | Reach | Job type |
| --- | --- | --- | --- |
| Boiler flue | 150 mm | Vertical, 3.2 m, two elbows | `scan_pipe` |
| Under-sink waste run | 40 mm | Horizontal, 2.1 m, one tee | `scan_pipe` |
| Kitchen extract duct | 200 mm × 300 mm | Horizontal, 4.4 m, 2 branches | `scan_duct` |
| Bathroom extract duct | 125 mm | Vertical, 2.6 m | `scan_duct` |
| Under-floor void | 140 mm | Perimeter crawl, 18 m loop | `scan_duct` |
| Wall cavity (kitchen) | 90 mm | 3.4 m chase | `scan_pipe` |

Bores below **80 mm are exclusive to the inchworm**. The 40 mm waste run is
inaccessible to everything else, permanently. That is the point of including it.

### 2.3 Volumetric manifold

Stairwell (2.4 m rise), attic void (1.6 m, 0.9 m of headroom at the ridge),
ceiling beam grid over the living room (7 beams, 0.28 m), a service shaft
(0.6 × 0.6 × 4 m), and elevated shelving in the garage alcove at 1.7 m.

The attic is deliberately awkward: 0.9 m headroom is below the hover bot's
ceiling clearance of 1.0 m, so the hover bot must fly low and slowly, and the
cost of the attic job is dominated by attitude control. Cost is a design
variable here, not an afterthought.

### 2.4 Ports

Manifolds touch only at **ports**, and a port is a typed object with a position,
a radius and a connecting pair of manifolds. This is the structural rule that
makes handoff and recombination expressible at all.

| Port | Connects | Used by |
| --- | --- | --- |
| `vent-bath-ceiling` | volumetric ↔ constrained | Hover enters duct register |
| `vent-kitchen-wall` | volumetric ↔ constrained | Hover delivers to extract duct |
| `hatch-attic-stair` | volumetric ↔ volumetric | Ground reaches attic |
| `appliance-front-boiler` | ground ↔ ground | Ground recharges, inchworm docks |
| `duct-drop-utility` | constrained ↔ ground | Inchworm exit |
| `shaft-cap-garage` | volumetric ↔ volumetric | Hover-only shortcut |

Jobs cross manifolds only through ports. An inchworm cannot deliver a finding to
the living room by itself; it exits at `duct-drop-utility` and the job crosses a
port boundary. That constraint is the substrate handoff logic runs on.

### 2.5 The three manifolds, and why three

Three representations, because three movement models genuinely require three. A
grid-based navmesh cannot express "cannot leave the pipe", and pretending
otherwise produces a simulation that proves nothing about the real problem.

| Manifold | Nav representation | Locomotion | Why it cannot be the other kind |
| --- | --- | --- | --- |
| Ground | 2D occupancy grid, 0.05 m cells, A* | Differential drive, 2 wheels + caster, nonholonomic | Floor-only. Falls off stairs. |
| Constrained | **Lumen graph**: swept polylines with bore radius; pose is arc length + lateral offset | Segmented crawl, peristaltic, 6 segments | Pose is 1-D along a curve. Grid matching is meaningless here — there is no 2-D structure to match against. |
| Volumetric | Sparse 3D voxel, 0.10 m, free-flight A* | Hover, thrust-vectored, no gravity | Has vertical freedom. Would fall. |

A consequence worth stating because it constrains the SLAM design: **the
inchworm cannot use scan matching**, because scan matching needs a locally
isometric 2-D patch and the inside of a pipe has none. Its localisation is
graph-relational (§5.3).

### 2.6 Anomalies — the hidden oracle

`content/anomalies-01.json` is the ground truth. **The sim reads it to compute
metrics. No agent, sensor or detector may query it.** Enforced by module
boundary and by a test that greps `sim/sensors/` and `sim/slam/` for the import.

| Class | Count | True signal | Detectable by | Notes |
| --- | --- | --- | --- | --- |
| `moisture_leak` | 4 | Moisture field | Ground (humidity), inchworm (humidity in voids) | Kitchen under-sink, bathroom seal, attic roof, under-floor |
| `thermal_anomaly` | 5 | Temperature field | Ground (thermal), hover (thermal) | Boiler overheat, fridge seal fail, attic solar gain, missing insulation, blocked vent |
| `structural_crack` | 3 | Geometry + RGB | Ground, hover | Stairwell lintel, ceiling beam, chimney breast |
| `blocked_vent` | 3 | Geometry / airflow | Hover, inchworm | Two ducts, one register |
| `clutter_hazard` | 4 | Geometry | Ground, hover | Trip and obstruction hazards |
| `pest_indicator` | 2 | Geometry + thermal | Inchworm, hover | In voids and the shaft |

Each label carries `{id, class, position, extent{halfExtents, frame}, severity,
manifold, expectedDetector}`. **Extent matters and is easy to skip:** a detector
that finds the right defect in the wrong place, or the right place with the wrong
size, is a partial success, and the IoU term in §9.2 is what records that.

Total: **21 authored anomalies.** That is enough for a meaningful confusion
matrix and few enough to review by hand. Beyond ~40 the authored set stops being
verifiable and the accuracy numbers stop meaning anything.

### 2.7 The three fields

Temperature, moisture and air quality exist as continuous scalar fields over the
world, sampled by sensors through observation models (§4) and authored as
ground truth for scoring. Each is a background (seasonal/diurnal gradient) plus
point sources with anisotropic diffusion, plus per-anomaly modifiers.

`thermal_anomaly` defects are not separate from the field — **they are the
field.** A boiler overheat *is* a hot source in the temperature field. This
coupling is deliberate: it means an agent cannot detect a thermal anomaly by
"looking for a red thing", only by integrating evidence against a baseline it
must estimate itself. That is the actual skill, and it is the thing worth
testing.

---

## 3. Agents

### 3.1 Ground bot — `ground-01`

| Property | Value |
| --- | --- |
| Locomotion | Differential drive, 2 driven wheels + caster |
| IMU cal | One-shot at dock, 2.0 s. Residual bias 15% of initial, decaying to 60% over a mission (§4.5.1) |
| Kinematics | Nonholonomic: cannot strafe. Turning radius 0.34 m minimum |
| Body | 0.34 × 0.26 × 0.11 m |
| Mass / speed | 8.4 kg · 0.55 m/s cruise, 0.85 m/s burst |
| Power | 22 W cruise, 14 W sensors, 48 W total peak |
| Battery | 38 Wh |
| Capabilities | `ground.drive`, `sense.depth`, `sense.thermal`, `sense.humidity`, `sense.imu`, `map.local`, `map.merge` |
| Cannot | Enter any bore < 250 mm; climb; see over 0.42 m |

The clearance profile is the interesting constraint. Low, fast, good sensors,
power-hungry, and blind above furniture height. It is the workhorse and it will
do most of the jobs, which is correct and worth noticing — the swarm's value is
in the last 15%, not the first 85%.

### 3.2 Inchworm bot — `inch-01`

| Property | Value |
| --- | --- |
| Locomotion | Segmented peristaltic crawl, 6 segments, 0.28 m deployed |
| IMU cal | One-shot at dock, 2.0 s. Residual 15% → 60%. **Worst drift decay of the three**: it cannot return to a dock mid-conduit, so a recal means abandoning and re-entering the bore |
| Kinematics | 1-D along lumen curve + bounded lateral offset (±0.4 bore) |
| Mass / speed | 1.1 kg · 0.09 m/s crawl, 0.14 m/s in straight bores |
| Power | 9 W crawl, 8 W sensors, 16 W total peak |
| Battery | 12 Wh |
| Capabilities | `crawl.small` (≤80 mm), `crawl.medium` (≤250 mm), `sense.depth`, `sense.imu`, `map.graph`, `map.merge` |
| Cannot | See thermally; leave a conduit without a port; turn around inside a 40 mm bore (single-file, irreversible) |

Two deliberate traps:

1. **No thermal sensor.** The inchworm is the only agent that can reach some
   defects and can never confirm them. It can only report "something here" and
   escalate. This forces the handoff path to exist for capability, not just for
   distance.
2. **Single-file irreversibility.** Entering a 40 mm bore means committing to the
   full 2.1 m. Trapped-because-of-a-job-assignment is a real failure mode this
   sim must be able to produce, because the allocation logic must avoid causing
   it. `test-scenarios.md` §S6 tries.

Third consequence of the §4.5.1 decision, and the one that makes it interesting:
**this bot is the only one whose accuracy cannot be restored.** The ground and
hover bots recalibrate almost incidentally — the hover bot returns to dock anyway
on its 104 W draw — while the inchworm commits to whatever bore it entered. Over
a full survey its residual bias climbs to 60%, and no later job can fix it. If
localisation degrades enough to strand it, that is the system's real behaviour,
not a modelling artefact.

### 3.3 Hover bot — `hover-01`

| Property | Value |
| --- | --- |
| Locomotion | Micro-hover, thrust-vectored, 4 rotors, no aerodynamic model |
| IMU cal | One-shot at dock, 2.0 s. Residual 15% → 60%. **Best drift decay in practice**: 104 W peak draw means it returns to dock often anyway, so recalibration is nearly free |
| Kinematics | Full 6-DoF attitude, ±0.4 m/s, ±40 °/s |
| Body | 0.24 m across rotors |
| Mass / speed | 0.9 kg · 0.4 m/s cruise |
| Power | **86 W hover (the dominant draw), 12 W sensors, 104 W peak** |
| Battery | 22 Wh |
| Ceiling clearance | 1.0 m |
| Capabilities | `hover.stable`, `sense.depth`, `sense.thermal`, `sense.rgb`, `sense.imu`, `map.local`, `map.merge` |
| Cannot | Enter voids; maintain altitude in a 0.9 m attic without cost penalty |

The power number is the important one. **The hover bot burns 4× the ground bot
while carrying a 58% smaller battery** — roughly 4.4× worse endurance. Any
allocation scheme that is not actively power-aware will spend the hover bot on
travel it does not need to make. The auction (§6.3) exists partly to prevent
that, and §S6 is where we find out whether it does.

### 3.4 Capability model

Capabilities are opaque string tokens, declared per agent, and every job
declares the set it requires. Allocation is set containment. No per-job special
cases, ever — if a job type needs a special case, it is expressed as a capability
the agent lacks, and the general logic handles it.

One capability exists for maintenance rather than inspection:

| Token | Held by | Meaning |
| --- | --- | --- |
| `recal.port` | ground, hover | Can re-run the §4.5.1 calibration by returning to a port |

**The inchworm does not hold it.** It cannot reach a port mid-conduit without
abandoning and re-entering the bore, so for `inch-01` a recal is not a job — it
is an expedition. Modelling that as a missing capability rather than a cost
modifier means the general allocation logic handles it with no special case, which
is the point of §3.4. The consequence is concrete: **the inchworm's map quality
monotonically worsens over a mission and cannot be improved**, and the system
must cope with that rather than route around it.

---

## 4. Sensor simulation

All sensors are **observation models**: functions from world state to a noisy
measurement, plus a validity flag. None of them rasterises anything in v1.

### 4.1 Depth / ToF

Ray fan cast against manifold geometry; returns points with per-point confidence
and a range limit (ground 3.0 m, inchworm 0.4 m, hover 4.5 m). Noise: axial
σ growing quadratically with range (σ = 0.004 + 0.002 r²), plus 1.5% dropout,
plus rare multiplicative spike outliers at glass and specular surfaces.
Point clouds are decimated to a fixed budget per tick (2,048) by deterministic
stride, so the sensor cost does not vary with scene density.

### 4.2 Thermal

Samples the temperature field through a modelled PSF: a 3 × 3 spatial blur
(thermal cameras genuinely lack sharpness) plus NETD noise σ = 0.03 K plus
emissivity error, which is the dominant real-world error — a 0.90-emissivity
target read against a 0.95 surface reads ~4 K low, which is larger than several
of our anomalies. **Emissivity error is tuned so that a naive single-frame
threshold detector is worse than a baseline-relative detector.** That gap is a
result, not a nuisance.

### 4.3 Humidity / moisture

Scalar with a physically sluggish response: first-order lag, τ = 4 s, plus
sensor drift and a per-agent calibration offset that is *unknown to the agent*.
A bias that no agent can estimate is the honest way to force relative rather than
absolute thresholds, and it is why the report must carry confidence intervals.

### 4.4 Air quality

VOC proxy scalar over the air field, heavily smoothed. Cheap, and it exists to
carry the duct jobs' non-visual evidence.

### 4.5 IMU

Angular rate and linear acceleration with white noise plus a **bias random
walk**. This is the sole source of pose drift in the whole simulation — every
metre of drift the maps accumulate is attributable to this term, which makes it
the highest-leverage noise parameter in the system and the one §S8 sweeps.

#### 4.5.1 Bias calibration — one-shot, imperfect, decaying

**Decision: v1 includes a one-shot calibration routine.** An agent leaving dock
runs a stationary + known-motion excitation pattern for 2.0 s and estimates its
bias vector. Cheap, plausible, and it assumes only a modest IMU stack.

**The important part: the calibration is deliberately imperfect.** A calibration
that fully removed bias would delete drift entirely, and drift is the input to
loop closure, fusion and every localisation metric in §9.3. The three-state model:

| State | Residual bias | Meaning |
| --- | --- | --- |
| **Uncalibrated** | Full | At dock, before first run, or after a forced recal failure |
| **Calibrated** | σ = 15% of initial bias, fixed | Post-dock estimate, held constant — no online refinement |
| **Drifted** | σ grows linearly to 60% over a mission | Real MEMS bias is temperature-dependent and walks with time |

So calibration buys a **~6.7× reduction in drift rate** at the start of a
mission, decaying to ~1.7× by the end. That decay is deliberate and it is the
interesting behaviour:

- It makes **mission length matter**. A long survey drifts toward uncalibrated
  performance, which is the honest behaviour of real hardware and gives
  `time to 90% coverage` a reason to exist.
- It makes **recalibration a resource decision** — an agent mid-mission has to
  return to a port, which costs travel, energy and availability. That interacts
  with the auction (§6.3) and with the `irreversibleRisk` term.
- It gives §S4 a second axis: closure is more valuable later in a mission than
  at the start, because by then the residual bias is 3–4× larger. **A single
  ATE number averaged over a mission hides that. So §9.3 requires drift rate and
  closure benefit to be reported as time series, not scalars.**

Calibration is modelled in the event log as `agent.calibrated` with the achieved
residual, so a report can say *this map's accuracy reflects a 34-minute-old
calibration* rather than implying a constant.

Rejected alternative: perfect calibration with online refinement. It is more
realistic at the end of a mission and it destroys the drift phenomenon this
project exists to study. Rejected alternative: no calibration at all. It
overstates drift, and per the decision it misrepresents what a modest real IMU
achieves with a basic routine. **The middle — imperfect, decaying, re-obtainable
at a cost — is the honest model.**

### 4.6 RGB — deferred, with the cost itemised

**Cut from v1, deliberately, recorded here rather than omitted silently.**

RGB is *load-bearing for 6 of the 21 anomalies* — crack, clutter and
pest-indicator detection are visual, and without it v1 uses geometric proxies
instead. So this is a real capability loss, not a rounding error. The justification
is that the loss is measurable and bounded, and the cost is not.

**CPU cost, per tick, per agent:**

| Stage | ms | Note |
| --- | --- | --- |
| Rasterisation (640×480, off-screen target) | 1.8 | Per active camera |
| Image-to-point correspondences for scan matching | 6.1 | The dominant term; needs a KD-tree over 307k px |
| Descriptor extraction + place-recognition index | 2.9 | Also unlocks the loop-closure primitive §5.2 lacks |
| Encoding + event-log serialisation | 0.6 | |
| **Per agent** | **11.4** | |
| **Three agents** | **34.2** | |

Existing per-tick perception + registration budget is **4.1 ms** (three agents,
ground ICP + hover point-to-plane). So RGB is **~8× the entire rest of perception
and registration**, not the 3× I first estimated. At 10 Hz that is 342 ms/s of
CPU for a capability that improves 6 of 21 anomalies.

**Memory cost, and this is the worse one.** The typed event log (§1.5) is a
primary structure, not a debug byproduct. A 600 s run at 10 Hz is 6,000 frames
per agent; at ~80 KB per PNG that is **~1.4 GB of log** for one scenario. The
log becomes the memory ceiling, the thing that has to be sampled or truncated —
and a sampled log breaks the guarantee that metrics are a function of evidence.
That is precisely the failure MIL ADR-001 §2 already paid for at 20,000 events,
and it would be paid again, larger.

**Mitigations if RGB lands (all deferred with it):** frames stored as reference
+ delta, not full frames; a separate cap on image events distinct from the scalar
event log; and metrics recomputed from the scalar log at report time rather than
from stored frames.

**Deferral rule, so this stays a decision rather than a drift: RGB enters in v2,
and it enters before the anomaly set grows.** When it does, `structural_crack`
and `pest_indicator` metrics get reported as a separate series, because their v1
numbers are known to be pessimistic (geometric proxies over-fire) and must not be
compared against v2 numbers. A v1→v2 comparison that mixes those classes into one
F1 would show improvement where none occurred.

### 4.7 Noise parameters

All noise is seeded from the sim PRNG and all parameters live in one table,
`NOISE` in `sim/sensors/noise.ts`, so §S8 can sweep a single multiplier across
every sensor at once. `noiseMultiplier: 0` is a legitimate scenario and must
produce a run with no failures at all — that is the control condition, and if the
control is not clean, every other number is uninterpretable.

---

## 5. SLAM and map fusion

The real thing, simplified. Not a stub and not a fake: the failure modes are the
subject.

### 5.1 Ground bot — 2-D scan matching

Occupancy-grid local map, keyframes on distance and heading change. Registration
by scan-to-submap matching on the occupancy gradient (a correlation-style
simplification of ICP, fixed iteration count for determinism). Pose graph over
keyframes, SE(2), Gauss-Newton, fixed 6 iterations.

### 5.2 Loop closure

Keyframe pairs compared by occupancy-cell **distance-transform correlation** —
not a bag-of-visual-words descriptor, because there are no images in v1 and
inventing a surrogate descriptor would be simulating a capability the robot does
not have. The distance transform is the right primitive here: it matches two
mappings of the same space regardless of appearance.

Closure is gated: below a correlation threshold the pair is rejected, and rejected
candidates are counted as a metric, because **a closure system that never rejects
anything is worse than one that never closes** — it produces confident wrong maps.
`closurePrecision` is in §9.

### 5.3 Inchworm — graph-relational localisation

Different algorithm, because the geometry demands it. Inside a bore there is no
isometric 2-D patch, so:

- **Pose** = (conduit id, arc length s, lateral offset). Three numbers, not three
  plus a yaw.
- **Odometry** from segment articulation, with the IMU bias walk as the drift
  term.
- **Feature nodes** at authored junction and termination points — tees, elbows,
  duct registers. Revisiting a feature node is a loop closure, and it is a
  *parameter* correction, not a pose-graph edge.
- Residual correction: minimise the discrepancy between integrated arc length and
  known feature-node spacing along the polyline.

This means the inchworm's map is a graph, and fusion with the other two agents'
metric maps requires registration through ports (§5.5).

### 5.4 Hover bot — 3-D sparse

Sparse 3-D voxel map, point-to-plane registration on voxel boundary planes,
SE(3) pose graph, fixed Gauss-Newton. Higher complexity than the ground bot
simply because the state is larger, and the tick budget in §9.6 is where that
shows up.

### 5.5 Fusion — the shared map

Each agent submits map chunks with a transform and a covariance. The
coordinator:

1. Registers overlapping chunks pairwise, adding **inter-agent constraints** to a
   single global pose graph.
2. Re-optimises globally.
3. Publishes the fused map to all agents — asynchronously, because comms latency
   is a parameter and pretending it is zero would flatter the result.

**Disagreement is not averaged away, it is measured.** The residual of the fused
graph is a first-class metric (§9.3). Two robots that disagree about where a wall
is produce a measurable residual, and that residual is the honest report of map
consistency. Systems that fuse by naive averaging cannot report this, which is
why this project fuses by optimisation.

### 5.6 Exploration and frontier behaviour

Frontier-based exploration on each agent's *local* map, biased by the global map
only through the shared frontier list — which means an agent with a poor fused map
has poor exploration, and the coupling is visible. Two behaviours worth naming
because they are the ones that break:

- **Revisit.** Deliberate return to a frontier region when a keyframe's
  information gain has decayed. Required for the drift test (§S4) — without it,
  the loop closure never gets the chance to fire.
- **Inconsistency handling.** Where two agents' fused maps disagree beyond
  threshold, the region is flagged `contested` and re-queued as a job at elevated
  priority. This is the mechanism by which map fusion feeds back into allocation,
  and it is the most interesting loop in the system.

---

## 6. Job system

### 6.1 Job schema

```ts
type Job = {
  id: JobId;                  // stable, sortable, never reused
  type: JobType;
  region: Region;             // aabb or lumen-arc or frontier set
  port?: PortId;              // required if region is in another manifold
  requiredCapabilities: Capability[];
  priority: number;           // 0-100
  expectedOutput: OutputSpec;
  state: 'announced' | 'awarded' | 'active' | 'blocked' | 'done' | 'failed';
  announcedAtTick: number;
  decomposedFrom?: JobId;    // set when a job splits for recombination
  escalations: number;
}
```

`expectedOutput` is a **typed contract, not prose**: `{kind: 'thermalMap',
resolution: 0.05, minConfidence: 0.6}`. A job is only `done` when its output
meets the spec. This is what stops "done" meaning "walked there and looked".

### 6.2 Job types

| Type | Requires | Output |
| --- | --- | --- |
| `map_region` | any locomotion | Occupancy chunk + coverage delta |
| `scan_pipe` | `crawl.small`/`crawl.medium` | Humidity series + obstruction flags |
| `scan_duct` | `crawl.medium` | Air series + airflow rate |
| `scan_ceiling` | `hover.stable` | Thermal raster + defect list |
| `scan_appliance` | `ground.drive` | Thermal raster + surface temp |
| `verify_thermal` | `sense.thermal` | Confirmation with confidence |
| `verify_moisture` | `sense.humidity` | Confirmation with confidence |
| `resolve_contested` | any | Map agreement report |

Note that `scan_ceiling` and `scan_appliance` have different required
capabilities. A ceiling job needs the hover bot even though the appliance is
visible from the floor, because a thermal raster of a ceiling void needs a
vantage point inside the void. **Capability requirements are about vantage, not
just access** — this trips up every first implementation and it is written down
here so it is not rediscovered as a bug.

### 6.3 Allocation — contract net

Announce → bid window (default 12 ticks) → award by score → monitor. The
coordinator is not omniscient: it only knows what has been announced and what has
been bid, and it cannot see through walls or into unallocated jobs' regions.

```
score = 3.0 · capabilityFit        // 1.0 if all required present, else ineligible
      + 1.5 · (1 − d_norm)         // path distance over the agent's own map
      + 1.2 · batteryHeadroom      // fraction of energy needed to complete
      − 1.0 · currentLoad
      − 2.0 · irreversibleRisk     // single-file commitment, vaulted spaces
```

Design notes, each load-bearing:

- **Distance is over the agent's own map.** A bot with a bad map bids as if the
  job is far away. This is why map quality feeds allocation, and why the fused
  map matters beyond the report.
- **`irreversibleRisk` is a first-class term.** Without it, an inchworm will bid
  optimistically for a 40 mm bore it cannot turn around in, and the swarm will
  strand a bot. The penalty is what stops that, and §S6 measures whether it is
  enough.
- **Tie-break on agent ID, always.** A tie in a floating-point score is otherwise
  resolved by iteration order, which is a determinism bug waiting to happen.
- **Battery headroom is scored, not just filtered.** Filtering on "can I afford
  it" makes the swarm brittle; scoring makes it prefer the *cheapest sufficient*
  agent, which is what makes a swarm worth more than one robot.

### 6.4 Handoff

Three distinct mechanisms, deliberately not conflated:

1. **Escalation.** An inchworm reports a finding it cannot confirm (no thermal
   sensor). A `verify_thermal` job is spawned at the nearest port. This is
   capability handoff and needs no physical co-location.
2. **Port handoff.** A job whose region lies beyond an agent's reach is executed
   in two stages across a port: inchworm does the conduit, ground bot does the
   room. The ground bot inherits the chunk with a transform whose uncertainty is
   the inchworm's.
3. **Failure handoff.** Awarded job fails or times out → re-announce with the
   failed agent excluded for N ticks. Prevents two agents thrashing on the same
   unsolvable job.

### 6.5 Deadlines and starvation

Jobs have soft deadlines by priority tier. A job that has been announced with no
eligible bidder for 40 ticks escalates its own priority and logs
`job.starved` — because **an allocation system that quietly drops hard jobs will
produce a high completion rate and a low coverage score**, and only one of those
is visible to a stakeholder. Both are in §9.

---

## 7. Swarm coordination

### 7.1 Recombination — defined, because the brief does not define it

The brief asks for "recombination (bots forming chains or clusters)". Forming a
physical chain is **cut from v1**: it requires attachment kinematics, docking
compliant mechanics and a control problem that is not the subject here. Adopting
it would also make the whole thing unbuildable in a weekend, and this document's
thesis needs the *decision* tested, not the docking.

**Recombination in v1 is a co-located composite observation.** Two or more
agents of different classes enter a `cluster` state at a shared location or a
shared port, and execute one job that is decomposed so that no single agent can
complete it:

```
  composite job
    ├─ inch-01  reach the defect, localise it, provide humidity evidence
    └─ hover-01 provide thermal confirmation from the only vantage
       → fused confidence
```

Fusion of independent evidence: `c = 1 − (1 − c₁)(1 − c₂)`, capped at 0.95.
The **confidence delta** is logged per cluster, which yields a metric (§9.4) that
answers the thesis question with a number instead of a vibe.

Three cluster types, deliberately distinct because they test different things:

| Type | Members | Tests |
| --- | --- | --- |
| `capability` | Any two | Does confirmation-by-committee beat single-sensor? |
| `sensory` | Two with overlapping sensors | Does redundancy raise confidence or only cost energy? |
| `traverse` | Inchworm + ground across a port | Does the port boundary survive a job crossing? |

`traverse` is the one that can fail in an interesting way: the ground bot's
transform inherits the inchworm's uncertainty, and if the inchworm's map is bad,
the composite's confidence is bad too. **Correlated error across a handoff is
the real risk in distributed perception**, and it is why confidence is fused
with a covariance check rather than a naive formula. If the two evidence
sources' covariances overlap, the naive formula overstates confidence and the
system must discount it.

### 7.2 Cluster lifecycle

Form on a decomposed job's demand → persist while both members hold the job →
dissolve on completion, timeout, or member loss. Events `cluster.formed` /
`cluster.dissolved` carry member IDs, type, duration and confidence delta.
Duration is itself a finding: a cluster that lingers is wasted energy.

### 7.3 Coverage optimisation

The coordinator maintains a global coverage grid per manifold and a frontier
queue. It does not command agents; it only makes jobs attractive. **Coordination
is by market, not by instruction** — the moment the coordinator can order a bot
somewhere, the whole architecture collapses into one big central planner with
three bodies, which is a different (and worse) system. The failure mode to guard
against is "the coordinator is good enough that the agents are just sensors with
wheels."

### 7.4 Fallback behaviours

| Situation | Behaviour |
| --- | --- |
| No eligible bidder | Job starves, priority escalates, `job.starved` logged |
| Agent battery critical | Current jobs re-announced excluding it; agent returns to charge |
| Agent lost | Its held jobs re-announced; its map chunks retained by the coordinator |
| Comms partition | Agents fall back to local frontier exploration; fusion queues on heal |
| Fused map contradictory | Region flagged contested, re-queued as `resolve_contested` |
| Conflicting claims | Higher-priority job wins; loser logs `job.conflict` |

The comms-partition row is the important one. A fusion architecture that assumes
a reliable bus has not been tested, and the partition case is where the
distributed claim either holds or does not.

---

## 8. Inspection report

The product. `sim/report/` emits both a machine-readable document and the
fragments the viewer renders.

### 8.1 Contents

| Section | Content |
| --- | --- |
| 3D map | Fused point cloud + occupancy, per-manifold, with contested regions marked |
| Anomaly list | 21-or-fewer entries: class, position, extent, severity, confidence, **detector ID**, confirming agents |
| Thermal overlays | Per-agent rasters registered into the fused frame |
| Moisture overlays | Same |
| Structural observations | Crack and clutter findings, with confidence caveats |
| Per-bot logs | Timeline per agent: jobs, bids, closures, clusters, battery, faults |
| Confidence scores | Per finding, with the evidence that produced them |
| Coverage | Per manifold and total, with **explicitly named uncovered regions** |
| Detector appendix | Every claim with its detector ID and input events |

### 8.2 The honesty rules

These are the rules that make the report worth reading, and they are the reason
the typed event log is a primary structure:

1. **Every claim carries a detector ID.** No detector, no claim.
2. **Absent evidence is reported, not omitted.** "No crack detected in the
   stairwell" without "stairwell coverage 61%, crack detection requires ≥85%"
   is a misleading sentence, and the report must not be able to produce it. The
   generator physically cannot emit a negative claim about an under-covered
   region; it emits the coverage figure and the threshold instead.
3. **Confidence is a number with a derivation**, not a word.
4. **Unverified findings are labelled `UNVERIFIED`**, which for the inchworm's
   reports means the default state. An unverified finding is still useful; it just
   must not be presented as confirmed.
5. **The report states what it could not do.** Bot lost, job starved, region
   contested at end of run — all surfaced. A report that only lists successes is
   a marketing document.

### 8.3 Viewer

Three.js, reads a frame, writes nothing. Free-fly and orbit cameras, a manifold
filter, live toggles for depth / thermal / moisture / fused-map / truth overlay
(truth overlay is a debug view, off by default and labelled as such when on).
Anomaly markers clickable to their evidence. A metrics panel with the detector
IDs behind each number, so the viewer is an interrogation tool rather than a
demo.

---

## 9. Evaluation metrics

Every metric has at least one detector ID producing it (§1.5). Nothing here is
computed from final state alone.

### 9.1 Coverage

- **Coverage %** per manifold and total: fraction of authored free-space volume
  observed to the required resolution. Computed against ground truth — legitimate,
  because coverage is an *evaluation* metric, not an agent capability, and the
  distinction is enforced by module boundary.
- **Coverage per job type**, because 100% ground coverage with 40% duct coverage
  is a different system from the reverse.
- **Time to 90% coverage**, which is the number a real inspection is sold on.

### 9.2 Detection accuracy

- **Precision, recall, F1 per anomaly class** — 6 classes × 2 numbers each,
  matched by class plus IoU ≥ 0.3 on extent.
- **Localisation error**: centroid distance, per class. A class detected reliably
  in the wrong place is a different product from one detected reliably in the
  right place, and F1 alone cannot tell them apart.
- **Extent IoU** per matched pair.
- **False positives per run**, because a report with 21 findings and 40
  speculative ones is not usable by a human even if recall is perfect.

### 9.3 Map quality

- **ATE** (absolute trajectory error) and **RPE** per agent, against ground-truth
  pose. The primary localisation numbers.
- **Loop closure precision and recall** — from the rejection gate (§5.2).
  Reported as a pair, never as one number.
- **Drift rate**, m per 10 m travelled, before and after closure — **as a time
  series, not a scalar.** Required because of §4.5.1: residual bias decays from
  15% to 60% of initial over a mission, so closure is worth far more late than
  early. A mission-average ATE hides a 3–4× variation in the thing being
  measured.
- **Calibration age at report time** per agent, and **closure benefit vs.
  calibration age** — the correlation between the two is the evidence that the
  calibration model is doing work.
- **Fusion residual RMS** — cross-agent disagreement (§5.5).
- **Map completeness** vs authored geometry.

### 9.4 Swarm performance

This is the section the thesis lives or dies on.

- **Job completion time**: mean and p95, per job type. Plus **makespan**.
- **Swarm efficiency** = useful agent-seconds ÷ total agent-seconds. Idle agents
  and travel that does not produce evidence both count against it.
- **Recombination events**: count, mean duration, and **mean confidence delta**.
  The delta is the thesis measurement.
- **Handoff events**: count and success rate, per mechanism (§6.4).
- **Allocation regret**: distance the winning bidder actually travelled vs the
  optimal bidder's distance. Measures how good the market is, and it is the
  number that will reveal whether the auction or a greedy nearest-agent rule
  would do just as well. **If regret is negligible, the market is decoration and
  should be deleted.**
- **Starvation count** — jobs that timed out with no eligible bidder.
- **Contested regions** — count at end of run; a system that leaves many is
  reporting honestly about its own uncertainty, and a system that leaves none is
  probably hiding them.

### 9.5 Energy

- Per-agent Wh consumed, split by subsystem: locomotion, sensors, compute, comms.
- **Wh per confirmed anomaly** — the real efficiency number, and the one that
  would decide whether this is deployable.
- Battery-stranding events.
- The hover bot's 86 W draw means energy metrics are dominated by one agent
  unless allocation is good. §9.5 will therefore be mostly a measurement of §6.3.

### 9.6 Compute budget

Tick cost per system at 10 Hz, budgeted like MEGA F UP §20.5. Expected: the
hover bot's 3-D pose graph is the largest single item, and fusion re-optimisation
is the spike risk. If fusion exceeds budget, it becomes amortised across ticks —
and that trade (staleness vs cost) is itself a parameter worth sweeping.

### 9.7 The control condition

**Every scenario runs at `noiseMultiplier: 0` as well as at its nominal value.**
The zero-noise run must have no failures and 100% coverage. If it does not, the
bug is in the navigation or the allocation, not in the perception, and every
other number in the suite is uninterpretable. This control is cheap and it is the
difference between a test suite and a demo.

---

## 10. Constants

The contract between sim, content and viewer. Any change here is a version bump.

```
  TICK                10 Hz fixed
  RNG                 mulberry32, seeded per run, no Math.random anywhere
  MATH                + - * / and Math.sqrt only. §1.4
  GRID_CELL           0.05 m ground
  VOXEL_SIZE          0.10 m volumetric
  BORE_CLASSES        small ≤80 mm · medium ≤250 mm · large ≤350 mm

  GROUND   size 0.34×0.26×0.11 m · 0.55 m/s · turn R 0.34 m
           depth 3.0 m · thermal σ 0.03 K · humidity τ 4 s
           power 22+14 W · battery 38 Wh
  INCH     len 0.28 m · 6 segments · 0.09 m/s · depth 0.4 m
           NO thermal sensor · power 9+8 W · battery 12 Wh
  HOVER    0.24 m · 0.4 m/s · depth 4.5 m · clearance 1.0 m
           power 86+12 W · battery 22 Wh

  DEPTH_SIGMA          0.004 + 0.002 r²
  DEPTH_DROPOUT        1.5%
  DEPTH_BUDGET         2,048 pts/tick
  THERMAL_NETD         0.03 K
  THERMAL_PSF          3×3 blur
  EMISSIVITY_ERROR     0.90 read against 0.95 → ~4 K low
  HUMIDITY_TAU         4.0 s
  IMU_BIAS_WALK        per-agent, unknown to the agent
  IMU_CAL_DWELL        2.0 s stationary + known-motion excitation, at dock only
  IMU_CAL_RESIDUAL     15% of initial bias, decaying linearly to 60% over
                       MISSION_DRIFT_HORIZON (set to 1800 s)
  IMU_RECAL_COST       full return-to-port + redock; unavailable for 2.0 s

  BID_WINDOW           12 ticks
  STARVATION_TIMEOUT   40 ticks
  SCORE_W              capability 3.0 · distance 1.5 · battery 1.2
                       load −1.0 · irreversible −2.0
  CONFDENCE_FUSION     1 − (1−c₁)(1−c₂), cap 0.95, covariance discount
  COMMS_LATENCY        4 ticks (parameter, swept in §S7)

  ANOMALIES            21 across 6 classes
  COVERAGE_THRESHOLD   negative claims require ≥85% regional coverage
  MATCH_DISTANCE_M     3.0
  CONFIDENCE_MIN       0.6 to satisfy a job's expectedOutput
```

### 10.1 IOU_MATCH, retired

`IOU_MATCH 0.3` was declared here from the start and **no code ever read it**. It
was found while building the yacht domain, when a fault in the forward stringer
void came back as FOUND on the strength of a humidity reading taken on the engine
room sole, two metres away and in a different manifold.

Reading it would not have fixed that. It would have broken everything: measured
on the yacht run, the extent overlap between a finding and the fault it found was
**0.025 for a crawler sitting 0.00 m from a fuel-line obstruction**, because the
finding's box is a bore and the fault's box is a 500 mm lump of debris. IoU
measures *delineation*, not *detection*. The detectors here do not delineate:
the humidity detector localises to the agent because it has no bearing, so its
box is a guess about how far away the source is.

So the threshold that actually gates a match is the one the detectors can
satisfy — distance — and it is now declared in the content file and read, as
`MATCH_DISTANCE_M`. The extent overlap is still computed and still reported, as
the measure of delineation quality that it actually is.

Two rules came out of it, and both are now tests:

- **A parameter that no code reads is not a parameter.** If it is not going to
  gate anything, it should not be in the constants block pretending to.
- **A name that can move a number is doing physics.** The field builder switched
  on the *name* of a fault rather than on its physical signature, so renaming a
  fault silently deleted the field it produced. `test/world/domain-genericity.test.ts`
  renames every fault to a nonsense string and asserts the run is byte-identical.

A third rule, from the same round: **a candidate may only be credited to a fault
on the manifold it was found on.** The manifold is where the agent lives and
where its sensor is valid. A reading taken on the floor is not evidence about
the void above it, and an obstruction found inside a 60 mm fuel line is not a
blocked air vent in the room.

---

## 11. Implementation order

Thin slice first, then widen. Gates are pass/fail and stop the build.

| Stage | Content | Gate |
| --- | --- | --- |
| **A** | `types`, `rng`, `math`, `tick`, event log. House geometry, ground manifold + grid A*. Ground bot + differential drive + depth. Zero-noise coverage run. | Zero-noise control: 100% ground coverage, no faults. Determinism test green. |
| **B** | Anomaly fields + labels. Thermal, humidity, air sensors. Detectors. Metrics 9.1, 9.2, 9.7. Report generator, no viewer. | Report produced from a headless run, every claim carries a detector ID, no negative claim about under-covered region. |
| **C** | Jobs, auction, allocation. Handoff, starvation, regret. | §S6 battery case: no stranding at nominal battery. Regret measured, not assumed. **DONE — but S8 is not yet evaluable: with one agent, regret is identically zero.** |
| **D** | Viewer: fly camera, fused map, overlays, anomaly markers, metrics panel. | Every §9 number readable in the browser and traceable to a detector ID. **DONE.** |
| **E** | Inchworm: lumen graph, graph-relational SLAM, port traversal, capability handoff. | 40 mm waste run completed. Inchworm findings hand off at a port and get confirmed. |
| **F** | Hover bot: 3-D sparse map, SE(3) pose graph, ceiling/attic jobs. | Ceiling rasters at ≥0.6 confidence. Hover endurance respected by allocation. |
| **G** | Fusion: chunk registration, inter-agent constraints, contested regions. | Fusion residual reported. §S7 partition and heal recovers. |
| **H** | Recombination: three cluster types, confidence fusion, covariance discount. | **§S9: heterogeneous beats homogeneous.** The thesis test. |
| **I** | Volumetric traversal, shafts, traverse clusters, full scenario suite. | All of `test-scenarios.md` green with recorded numbers. |

**Gate A is the real gate.** If a deterministic zero-noise coverage run is not
clean, nothing above it means anything, and the cheapest place to find that out
is stage A.

### 11.1 Stage A — built 2026-10-01

| Module | File |
| --- | --- |
| Transcendental-restricted maths | `src/sim/math.ts` |
| Seeded PRNG | `src/sim/rng.ts` |
| Shared value types | `src/sim/types.ts` |
| Typed event log + order-sensitive hash | `src/sim/eventlog.ts` |
| House geometry, occupancy grid, distance transform | `src/sim/world/geometry.ts` |
| Content loader + schema validation | `src/sim/world/content.ts` |
| A* with deterministic tie-breaking | `src/sim/nav/astar.ts` |
| Depth sensor + footprint marking | `src/sim/sensors/depth.ts` |
| Ground bot: drive, frontier exploration, power, calibration | `src/sim/sim/agents.ts` |
| Run loop + coverage/energy/fault metrics | `src/sim/sim/run.ts` |

**Gate A result: PASSED.** 59 tests green, typecheck clean.
`noiseMultiplier: 0`, seed 1, 300 s: **coverage 100.00%** (25,800/25,800
navigable cells), 0 faults, 0 stranded, 0 starved, 1.2974 Wh consumed, log hash
`43ee5a77`, log not truncated.

**One structural finding, recorded because it looks like a bug in the sweep.**
S2's noise curve is *flat* at Stage A: coverage is 100% at every noise level
including ×10. That is correct, not a bug. Depth noise here perturbs the
*reported* point coordinates but not the agent's pose, and the pose is what SLAM
integrates. Until Stage E there is no pose estimate for noise to corrupt, so the
sweep has nothing to act on. **S2 becomes informative at Stage E, not before**,
and until then a flat sweep is the expected result rather than a null finding.

Also unimplemented at Stage A, and printed as `not yet implemented` rather than
`0` by `npm run scenario`: every §9.2 detection metric, §9.3 loop closure and
ATE, §9.4 regret and recombination, and the anomaly set. A zero there would read
as a measurement and quietly become the baseline later stages are compared
against.

### 11.3 Stage B — built 2026-10-01

| Module | File |
| --- | --- |
| The hidden oracle + schema validation | `src/sim/world/anomalies.ts` |
| Temperature / moisture / air fields | `src/sim/world/fields.ts` |
| Thermal sensor (bearing + range, emissivity, PSF) | `src/sim/sensors/thermal.ts` |
| Humidity and air sensors (lagged, unknown bias) | `src/sim/sensors/scalar.ts` |
| Detectors, incl. the naive control | `src/sim/sim/detectors.ts` |
| Detection metrics + candidate association | `src/sim/report/metrics.ts` |
| Report generator and the §8.2 rules | `src/sim/report/report.ts` |
| **The oracle-boundary test** | `test/boundary/no-ground-truth-leak.test.ts` |

**Gate B result: PASSED.** 94 tests green, typecheck clean.
Control at zero noise: 100.00% coverage, 0 faults, 0 stranded, log not truncated,
and every claim in the report carries a detector ID.

**Detection, ground manifold, seed 1, nominal noise** (14 ground instances, 12
reachable — see §13.7):

| Class | P | R | F1 | Loc | IoU | tp/fp/fn |
| --- | --- | --- | --- | --- | --- | --- |
| `blocked_vent` | 0.50 | 1.00 | 0.67 | 0.64 m | 0.03 | 1/1/0 |
| `clutter_hazard` | 0.75 | 0.75 | 0.75 | 0.26 m | 0.44 | 3/1/1 |
| `moisture_leak` | 0.25 | 1.00 | 0.40 | 0.38 m | 0.28 | 2/6/0 |
| `pest_indicator` | 0.25 | 1.00 | 0.40 | 0.63 m | 0.02 | 1/3/0 |
| `thermal_anomaly` | 0.27 | 1.00 | 0.42 | 1.49 m | 0.03 | 4/11/0 |
| `structural_crack` | — | — | — | — | — | 0/0/2 **undetectable, §13.7** |

**The headline is recall 1.00 on every class that can be reached. Precision is
the weak axis** — 22 false positives per run — and that is the expected shape of
a v1 with RGB deferred (spec §4.6, §13.1). A single aggregate number would have
hidden this; the per-class table is the reason §9.2 demands one.

### 11.4 What Stage B changed about the design

Four things the spec did not anticipate, all now in the code:

1. **Candidate association belongs in the report, not the detector.** A persistent
   defect is reported once per *approach*, not once per defect — drive past a boiler
   from four directions and the thermal detector fires each time. Raw that was 11
   false positives against 4 real anomalies and a precision of 0.20, which
   described the bookkeeping rather than the detector. Findings are now clustered
   with a radius that scales with each candidate's own extent, corroborating views
   raise confidence, and **the report and the metrics are computed from the same
   associated set** so the product cannot contradict its own numbers.

2. **Episode tracking in the detector, for the same reason at a different scale.**
   The authored thermal sources run to sigma 1.3 m, so one boiler's sightings
   genuinely land in different places and no report-level radius merges them without
   also merging distinct sources. The merge is a property of the *detector's*
   belief, so it lives there. Each episode keeps its best-supported view, so a
   finding is placed by the clearest view of the defect rather than the first,
   most distant one. This is what moved thermal precision 0.20 → 0.27 and
   localisation error 2.44 m → 1.49 m.

3. **`observedCount` and `surfaceCount` are separate arrays.** "The floor here is
   navigable and I have seen it" and "I have seen this wall" are different facts.
   Merging them into one array broke the frontier logic that drives coverage — a
   cell beside a wall counted as touching known space and the explorer followed the
   wall instead of opening up the room. Measured: **coverage fell 100% → 68%.**

4. **The emissivity term had to be resized to be testable.** At ±4 K it was
   smaller than every authored thermal anomaly, so the naive detector found them
   all with zero false positives and spec §4.2's claim was vacuous. At ±8 K it is
   comparable to the two smaller cold anomalies, which is where uncalibrated
   thresholds actually fail. **It is a tuning surface for the experiment, not a
   physical constant**, and the noise table says so.

### 11.5 Two pre-registered predictions the data overturned

Written before the numbers existed, and kept rather than quietly deleted, because
"we expected X and got Y, and here is why" is the useful artefact:

| Predicted (spec §2.6) | Measured | Why |
| --- | --- | --- |
| `thermal_anomaly` has the **best precision** | `blocked_vent` does (0.50 vs 0.27) | A blocked vent is a unary geometric test on a field with one source. A thermal finding competes with three other broad sources *and* with its own emissivity offset. Signal strength is not separability. |
| Thermal findings localise **better** than moisture, because the thermal camera has a bearing | Thermal localises **worse**: 1.49 m vs 0.38 m | The authored thermal sources are broad, and range from a ray fan through a broad blob is biased toward the robot — the profile's centroid sits nearer than the source. A proper 2-D blob fit across bearings is the fix, and it is v2 work. |

The second one is worth stating plainly because it contradicts a sensor-design
intuition: **a sensor with a bearing is not automatically better at localisation
than one without, if its range estimator is biased.**

### 11.6 Bugs found by the Stage B gate

Nine, and the pattern is worse than Stage A's: **a detector that returns nothing
looks exactly like a building with nothing wrong in it.**

1. **A magnitude gate of 118 K.** The naive control's second test was
   `absoluteThresholdK * 0.4` where the threshold was 296.15 K. Nothing can pass a
   118 K gate, so the control emitted **zero candidates for an entire stage** and
   every "the naive detector loses" assertion passed *vacuously*.
2. **A threshold named `quantile` compared as an absolute.** The blocked-vent
   detector was documented as firing on the low quantile of the run's own air
   distribution and was handed `0.8` — above the field's entire range of
   0.15–0.65. It never fired. A parameter whose name lies about its semantics
   reads as a working detector returning nothing.
3. **Physically backwards.** Blocked ventilation *raises* the VOC proxy; the first
   version fired on the low end, i.e. it would have reported good extraction as a
   fault.
4. **The off-by-one that hid every wall.** `castRay` returns the distance at which
   a ray *enters* a blocking cell, so the last sample of the marking loop always
   landed in the cell before it. Every occupied cell in the house stayed at zero
   surface observations **forever**, which made both the crack proxy and the pest
   proxy blind. They reported a plausible `0.00`.
5. **A crack proxy that could not fire.** It looked for an occupied cell with
   three free 4-neighbours. Every authored obstacle is at least three cells thick,
   so no cell of one ever has three free neighbours. An empty result is
   indistinguishable from a detector that is not running.
6. **70,000 candidates in one run.** The clutter detector emitted one finding per
   blocked *cell* per detection tick — a 0.8 × 0.6 m pile is ~190 cells. Precision
   was unmeasurable at 0.00. A hazard is an object; findings must track objects.
7. **Unbounded recursion** in the per-detector metrics breakdown, which
   re-scored each detector's subset including itself.
8. **Stale cross-modal fusion.** The pest proxy paired thermal evidence with
   obstructions regardless of age, so a reading taken beside the boiler was paired
   with a wall two rooms away. Evidence must be *contemporaneous* to be evidence of
   co-location.
9. **A control that differed from its subject in more than the variable under
   test.** The naive detector used coarse bearing-bucket suppression while the
   relative one used episodes, so it emitted *fewer* findings and appeared to win.
   A control that changes the bookkeeping as well as the decision is not a
   control; it now shares everything except the decision rule.

Plus one content/geometry trap worth recording: **a 0.10 m obstacle in a 0.05 m
grid with 0.20 m clearance becomes a 0.50 m impassable band, and the robot wedges
against it.** Authored "thin fissure" geometry for the crack detector had to be
removed because the navigation inflation made the defect unreachable. That is the
general finding in §13.7.

### 11.8 Stage C — built 2026-10-01

| Module | File |
| --- | --- |
| Job schema, requirements, output contracts | `src/sim/jobs/schema.ts` |
| Contract-net auction, scoring, regret | `src/sim/jobs/market.ts` |
| Recombination confidence fusion | `src/sim/sim/cluster.ts` |
| Market step inside the tick | `src/sim/sim/run.ts` |
| **The no-silent-detector guard** | `test/boundary/no-silent-detector.test.ts` |
| S8 — does the auction earn its keep? | `test/scenarios/s8-auction.test.ts` |
| Recombination, synthetic composites | `test/scenarios/recombination.test.ts` |

**Gate C result: PASSED.** 143 tests green, typecheck clean.
Control at zero noise: 100.00% coverage, 0 faults, 0 stranded, log not truncated.
149 jobs announced, 131 done, 18 starved, all 18 logged.

### 11.9 The precondition you asked for: no silent detectors

`test/boundary/no-silent-detector.test.ts` asserts that every registered detector
emits at least one candidate over the control scenario **unless it is declared
silent with a reason of substance.** Three properties, not one:

1. Nothing emits silently without an entry.
2. **Every allow-list entry names a detector that exists** — a stale entry would
   permanently excuse a detector nobody is checking.
3. **Every allow-list entry is still actually silent** — otherwise the entry would
   keep excasing a detector that has started working, and the real reason is lost.

Plus a dedicated assertion that the naive thermal control fires, since that is
the one that failed hardest: a 118 K gate meant "the naive detector loses" was true
for a whole stage without the naive detector ever having run.

`humidity.absolute` was listed in the registry with no implementation and has been
removed. **Listing a detector that does not exist is the same defect as one that
returns nothing** — both read as a clean result.

### 11.10 Jobs are spawned from findings, never from the oracle

This is the design decision Stage C had to get right, and the tempting version is
wrong. A coordinator that reads the anomaly file and announces a job per defect
produces a swarm that has been *told where the defects are*. Every §9.2 number
would still print and every one would be meaningless.

So jobs come from what the swarm has found: `map_region` from unobserved coverage,
and `verify_*` / `inspect_anomaly` from **detector candidates** — a suspicion, not a
fact. There is a test for it (`src/sim/jobs/` must not import the anomaly file), and
another asserting every verification job's region contains a candidate, so the
claim is checked where it lives rather than assumed.

### 11.11 What Stage C measured

| Metric | Value |
| --- | --- |
| Jobs announced / done / starved | 149 / 131 / 18 |
| **Allocation regret mean** | **0.00%** over 129 samples |
| Regret p95 / worst | 0.00% / 0.00% |
| Coverage | 100.00% |
| Energy | 1.7225 Wh (vs 1.2974 Wh without jobs) |

**Regret is identically zero, and S8 therefore cannot be evaluated yet.** With one
ground agent it wins every job it is eligible for, so it is always the best bidder
by construction. That is a property of the swarm's *size*, not a vindication of the
allocator — and it is exactly why the S8 verdict waits for Stage E. The number is
recorded so a baseline exists, and the scenario runner prints **"not evaluable"**
rather than `0.00%` so nobody mistakes the degenerate case for a result.

That jobs cost 33% more energy (1.72 Wh vs 1.30 Wh) is the first measured
trade-off between exploration and verification, and it is the number S9 will need.

### 11.12 A real regression, and the general finding behind it

**`pest_indicator` recall went from 1.00 to 0.00 when jobs were switched on.**
Nothing about the detector changed.

The mechanism: the pest proxy needs a thermal finding *and* an adjacent obstruction
within 120 ticks of each other. 149 jobs — mostly coverage jobs — change where the
robot is and when, so the co-occurrence that `pi-01` depends on stops happening.

> **Detection recall is a function of trajectory. A per-class recall number is not a
> property of the detector; it is a property of the detector *and* the policy.**

Two consequences, both taken:

1. **S3 now pins `enableJobs: false`.** The detection baseline must stay comparable
   across stages; letting it drift with the policy would mean the Stage B numbers
   could never be reproduced. There is a test asserting the pin, so a later edit
   cannot quietly turn the baseline into a moving target.
2. **The coverage-job policy is recorded as naive.** It announces the first
   unobserved cell in *scan order*, which produced 126 coverage jobs in a 300 s run.
   That is an upper bound on how badly policy can cost you, not a fair assessment of
   the job system. Ordering coverage jobs by frontier value is the fix, and it is
   Stage D work.

### 11.13 Bugs found by the Stage C gate

1. **`Math.pow` in the covariance discount.** Banned by ADR-001 §2.3, and the
   transcendental test caught it — the ban paying for itself on its first real use.
2. **Two S1/S3 assertions silently redefined by Stage C existing.** `starved: 0` and
   `pest_indicator` full-recall were both true when written and false once jobs
   existed. Both were rewritten rather than deleted: the S1 control now asserts
   faults and stranded agents (which must be zero) *separately* from starvation
   (which is now a measured, logged, non-zero quantity), and the S3 recall test
   pins the policy off. **Conflating "starved" with "faulted" would have hidden a
   robot death behind a policy artifact.**
3. **`awardedTo` asserted non-null on failed jobs** — which is wrong, because a
   starved job legitimately has no winner. Asserting a winner there would have been
   asserting that the failure path cannot happen.
4. **A test expectation that was simply wrong**, twice: `naiveFusion` of two 0.8
   readings is 0.95 (the cap trims 0.96), and a heterogeneous pair's
   `confidenceDelta` is exactly zero because there is no discount to apply. Both
   were my expectations, not the code. The second one exposed a genuine ambiguity in
   what `confidenceDelta` *means* — it is `fused − naive`, i.e. **what the discount
   took away**, not what recombination added. §9.4's recombination measurement is a
   different quantity, computed by `isLoadBearing`, and the test now says so.

### 11.14 Recombination tested without stub agents

The fusion maths is tested against **synthetic composite observations**, and the
inchworm and hover bot are deliberately *not* stubbed into the run.

A stub would have been faster and is a trap: a stub satisfying jobs it cannot
really reach would inflate coverage, drive regret toward zero for the wrong reason,
and hand Stage E a number it could not reproduce. The thesis machinery is worth
testing now; the agents are not, and faking them would put a false result into the
one suite whose job is to prevent exactly that.

What the tests establish, as arithmetic rather than hope:

- Two observations of **different** modalities fuse independently: delta exactly 0.
- Two of the **same** modality are discounted by 0.5 and the reason says *why* in
  words: "two agents reading the same physics are not two witnesses."
- The cap is applied **after** the discount, not before — otherwise a pair of
  near-certain repeats pins at 0.95 and then halves to 0.475.
- **The thesis holds as an identity:** at 0.55 each, a heterogeneous pair fuses to
  0.7975 and clears the 0.6 threshold; a homogeneous pair fuses to 0.4488 and does
  not. Neither single observation clears it either. So a heterogeneous swarm can
  confirm something no homogeneous pair can — §0's claim, tested before a single
  robot exists.

### 11.16 Stage D — built 2026-10-02

| Module | File |
| --- | --- |
| The viewer frame contract | `src/sim/report/frame.ts` |
| Three.js viewer, orbit + fly cameras | `src/view/viewer.ts` |
| Metrics panel with detector IDs | `src/view/panel.ts` |
| Browser entry, chunked simulation | `src/view/main.ts` |
| The frontier-value coverage policy | `src/sim/jobs/coverage.ts` |
| Its before/after test | `test/scenarios/coverage-policy.test.ts` |
| The DOM-purity guard | `test/boundary/no-render-imports.test.ts` |
| **The browser/headless parity pin** | `test/determinism/rng-and-replay.test.ts` |

**Gate D result: PASSED.** 159 tests green, typecheck clean, `vite build` clean.

### 11.17 The coverage policy, and a prediction that held

Stage C left a measured regression: `pest_indicator` recall 1.00 → 0.00 when jobs
were switched on, caused by 126 scan-order coverage jobs per run churning the
robot. The Stage C conclusion was that *detection recall is a function of
trajectory*, which made a specific and falsifiable prediction — **fix the policy,
not the threshold** — written down before the numbers were taken:

| | scan-order policy | frontier-region policy |
| --- | --- | --- |
| `map_region` jobs per 300 s | 126 | **19** |
| total jobs | 149 | **40** |
| starved | 18 | **9** |
| coverage | 100.00% | 100.00% |
| `pest_indicator` recall | 0.00 | **1.00** |
| `moisture_leak` precision | 0.22 | **0.67** |

The prediction held. The policy now groups frontier cells into **regions**,
ranks them by path distance over the robot's own map, weights priority by how well
*supported* each frontier is (observed neighbours per cell), and bounds how many
are in flight.

This is recorded at length because it is the project's clearest methodological
result: **moving the detector threshold would have produced the same recall number
with a worse system, and nothing in the output would have said so.** The cost was
in the *policy*, the evidence said so, and fixing the policy cost 1/6 of the jobs.

### 11.18 The viewer, and the claim it finally verified

ADR-001 §2.2 has always claimed the headless and browser paths execute identical
simulation code, so a bug reproduced in the browser is a bug in the tests. That was
a claim until Stage D made it a measurement.

**The viewer reported log hash `2923fbf7`. Node produced `2923fbf7`.** Same tick
count (3000), same coverage (100.00%), same job tally (40 announced / 31 done /
9 starved), same per-class P/R/F1 for all six classes.

The hash is now **pinned in the test suite**, alongside the tick count, the job
tally and the coverage. The pin is the mechanism that stops parity rotting: if the
simulation changes and the pin fails, whoever updates the constant has to
re-verify parity rather than bump a number because a test went red.

Other decisions in the viewer, each load-bearing:

- **It reads a frame, never the run.** `frameFromRun` copies the grid into fresh
  typed arrays. The viewer has no route into the simulation's internals to misuse,
  which is what makes the boundary mechanical rather than a convention.
- **The truth overlay is off by default and labelled when on**, and the panel says
  why: *nothing in the report or the metrics may use them*. A viewer that quietly
  showed the answer key would teach you nothing about whether the system works.
- **Every metric on screen carries its detector ID**, and the withheld-claims
  section is rendered rather than buried — §8.2 rule 2 made visible.
- **Per-room coverage is computed from the cells actually in each room.** Using the
  global figure for every room would have made the withheld-claims rule vacuous,
  which is exactly the failure that rule exists to prevent.
- Orbit controls are inlined (~90 lines) so the viewer's entire dependency surface
  is one import of `three`, and the boundary test has only `three` itself to reason
  about.

### 11.19 Two new guards

1. **No browser globals in the sim core.** One tsconfig types the whole package, so
   `src/view/` forces the DOM lib to be on — which makes `document`, `window` and
   `performance.now()` *legal* in the sim. The purity that used to come from the
   compiler now comes from a test instead, because a sim that can read
   `performance.now()` has results that depend on the machine it ran on, which
   breaks determinism at the root.
2. **The viewer exists and is the only importer of `three`**, asserted rather than
   assumed — a directory that exists in a spec and nowhere else is not a stage.

### 11.20 Bugs found by the Stage D gate

1. **The simulation's throughput was a function of the frame rate.** The first
   viewer yielded between tick chunks on `requestAnimationFrame`, and rAF is
   throttled when nothing is compositing — so a 3000-tick mission ran at about
   **four ticks per second** in a headless browser. The same code is ~3 ms/tick in
   Node. The fix is to chunk on a timer with a wall-clock budget and let the viewer
   keep its own rAF loop for rendering.
   **The failure mode is the one this project exists to prevent:** it makes a
   performance property of the host into a property of the simulation, which is
   precisely the machine-dependence the determinism work removed everywhere else.
2. **`run.report` did not exist.** The first frame builder reached for a report on
   the run, because nobody had decided where the report lives. Fixed by passing it
   in: the report is the product, and it has §8.2 rules a projection must not be
   able to bypass.
3. **A duplicated import and a dead placeholder** survived into the first frame
   module — `import { associateCandidates as _unusedAssociate }` and a
   `cells: ranked[0] === r ? -1 : 0` that was never meant to ship. Both caught by
   reading the file rather than by a test, which is its own reminder that not every
   defect is testable.
4. **The DOM lib is now legal in the sim.** See §11.19: the fix for a build error
   moved the purity boundary from the compiler to a test, where it is weaker and
   needs saying out loud.

### 11.21 Bugs found by the Stage A gate

Five, all of the same family: **a defect that produces a plausible number rather
than an error.** Recorded because each would have been expensive to find later.

1. **Int32 overflow in the distance transform.** `Int32Array` initialised to
   `0x7fffffff`, then `dist[i-1] + 2` — which wraps negative on the first
   relaxation and poisons the whole transform. Symptom: almost nothing passable.
   Fix: `Float64Array` with `Infinity`. A `0x7fffffff` sentinel in an integer
   array is not a safe "unreachable" marker.
2. **Inverted passability test.** Distance-to-obstacle is `>=` the radius, not
   `<=`. The wrong direction marks obstacle cells passable and leaves open space
   blocked — and A* then plans straight through furniture.
3. **Float multiply past 2^53 in the id hash.** `h * 2246822507` on a 32-bit `h`
   reaches 1.8e19, so the low bits are lost to rounding and the output clusters.
   Fix: `Math.imul`. Same bug class as (1), different arithmetic.
4. **`sin` Taylor series with the wrong sign alternation**, and fed arguments
   outside its convergence interval. Every term after `x³` inherited `x³`'s sign,
   so the series approximated `sin(1)` for all inputs — a defect that looks like a
   range problem rather than a sign one.
5. **A deadlock between two tolerances.** `driveToward` declared arrival at 0.15 m
   while the plan cursor advanced at 0.12 m, so the agent reached a waypoint,
   announced arrival, and could never advance past it. Now one shared
   `WAYPOINT_TOLERANCE`. The signature of this class is a run that looks alive —
   sensing, spending power, logging events — while the headline metric is frozen.

Also two design errors found by the control itself: the house was authored with
no doorways (so rooms were sealed and a perfect coverage figure covered a third
of the building), and the planner and the collision check disagreed about
clearance, because the mask already encodes the agent footprint and the check
inflated a second time. The second is worth keeping as a rule: **the mask is the
single source of truth about clearance, and no collision check may re-inflate.**

---

### 11.22 Stage E - built 2026-10-02

The inchworm, the constrained manifold, and the first honest answer to S8.

| Built | File |
| --- | --- |
| Lumen graph: arc parameterisation, port routing, bore classes | `src/sim/world/lumen.ts` |
| Inchworm locomotion, landmark latch, loop closure | `src/sim/sim/inchworm.ts` |
| Conduit content: six pipes, authored landmarks | `src/content/house-01.json` |
| Conduit survey jobs, spawned from unsurveyed bore | `src/sim/jobs/schema.ts` |
| Class dispatch in the run loop | `src/sim/sim/run.ts` |
| Regret evaluability and the kill verdict | `src/sim/jobs/market.ts` |
| 65 tests | `test/world/inchworm.test.ts` |

#### The three constraints the inchworm exists to impose

Spec §3.2 gives it no thermal sensor, a 40 mm irreversible bore, and no `recal.port`
capability. Each became load-bearing rather than decorative:

- **No thermal sensor** means every finding it could produce is a *suspicion* needing
  confirmation from an agent that cannot reach it. That is the entire argument for
  handoff being about *capability* and not just distance. Asserted: the crawler raises
  zero candidates.
- **Single-file below 80 mm** makes `irreversibleRisk` in §6.3 a safety term instead of
  a tie-breaker. A bid for the 40 mm waste run carries risk 1 and scores 3.66 where the
  ceiling is 5.70.
- **No `recal.port`** means the one agent whose accuracy degrades monotonically and
  cannot be restored, exactly as §4.5.1 says.

#### The constrained manifold is not connected, and that is the finding

`diag:lumen` reports **four** disconnected components. Every link between them is a
port, and no two of these ports serve the same conduit:

| Component | Conduits |
| --- | --- |
| flue ↔ kitchen extract | `flue-boiler`, `extract-kitchen` |
| bath extract | `extract-bath` |
| utility void | `void-perimeter` (28.3 m loop), `cavity-kitchen` (8.0 m loop) — via `duct-drop-utility` and `cavity-entry`, which are *not* linked to each other |
| kitchen waste | `waste-sink` (dead end) |

So `inchwormHomePort` selects which component the swarm can work at all, and the rest
is unreachable — not hard, not slow, **unreachable**. A crawler homed at the utility
drop surveys the perimeter void and can never see the under-sink waste run. The test
asserts both directions: unsurveyed bore in an unreachable conduit stays at exactly
zero, and the reachable one fills.

This is the strongest argument in the project for §2.4's port rule, and it is a
property of the *house*, not of the model.

#### S8 is still not evaluable, and now the simulator says so

Two agents at last. Regret: **mean 0.00%, n=37. `contestedAwards` = 0.**

Zero contested awards, because the two agents are on different manifolds and cannot
bid against each other for anything — the ground bot holds no `crawl.*` and the crawler
holds no `ground.drive`. Mean regret over uncontested awards is zero *by
construction*; it measures the absence of competition, not the quality of the
allocator.

So `auctionVerdict()` returns one of three states, and `not_evaluable` is a real
outcome with a real reason string:

```
S8 verdict: NOT EVALUABLE — only 0 awards had a second eligible bidder (need 5).
Regret over uncontested awards is zero by construction — it measures the absence
of competition, not the quality of the auction.
```

The previous test — `agents.length < 2` — was right at Stage C and **became wrong at
Stage E**: it would have cleared the two-agent run to print `BELOW KILL THRESHOLD —
delete the auction`, on the strength of an experiment that had not run. The check is
now on the *awards*, which is the only place the property exists.

**What would make S8 decidable**, stated so it is not quietly deferred again: two
eligible agents on the *same* manifold. Either a second ground bot, or the hover bot at
Stage F. Adding a second ground bot is artificial but legitimate — the swarm's premise
is multiple robots — and it is the next thing to do.

#### What the crawler did change

| | ground bot alone | with crawler |
| --- | --- | --- |
| jobs done | 32 | **38** |
| jobs starved | 12 | 11 |
| constrained coverage | 0.0% | 88.7% of the perimeter void |
| contested awards | 0 | 0 |

So the swarm completed more work and inspected a manifold nothing else can reach. But
it did so by **taking coverage jobs off the ground bot**, not by competing for them.
"The swarm did better" and "the swarm allocated better" are different claims and only
the first is supported — which is what `contestedAwards` is for.

#### Loop closure, and the drift bound

At `ODOMETRY_SCALE_ERROR` = 0.8% the drive train mis-measures, and uncorrected the
crawler would be **more than a metre wrong** after the length of this survey — wider
than the 0.12 m arrival tolerance it is judged against. So without loop closure it
would begin failing jobs it had physically reached. That is the operational cost of
drift, and it is why §5.3's claim matters rather than being tidiness.

On a 1-D manifold a revisited landmark fixes the coordinate completely — no residual,
no pose graph — so error is bounded by landmark spacing rather than by distance
travelled. `worstCaseDriftBound` reports that spacing per conduit, and it exposes a
content defect worth recording:

| Conduit | worst gap | note |
| --- | --- | --- |
| `void-perimeter` | **14.84 m** | landmarks at 3.0 / 8.4 / 13.5, then nothing for the last 14.8 m |
| `cavity-kitchen` | 6.39 m | one landmark, at 1.6 |
| `flue-boiler` | 3.32 m | |
| `waste-sink` | 1.20 m | the 40 mm dead end, best-instrumented |

At 0.8%, a 14.84 m gap is 11.9 cm of uncorrected error — within an inch of the arrival
tolerance. **The under-floor perimeter void is under-instrumented**, and the metric
that says so is the metric the stage was built to produce. Recording it rather than
adding landmarks until the number looked good.

#### Bugs found by the Stage E gate

Seven, and the first three are the purest instance yet of this project's recurring
class: **a subsystem that returns nothing looks exactly like a clean building.**

1. **2638 loop closures over 25 m of travel.** The landmark test was
   `featureNear(arc, step + 1e-6)`, so it re-fired on *every tick* the agent sat near a
   node, and `lastFeature` was rewritten each time. It reported **2638** closures and a
   drift rate of `0.085 m per 10 m` with three significant figures — a number shaped
   exactly like a measurement and made of pure numerical noise. Fixed with an explicit
   latch: a landmark is handled on *entry*, and the agent must leave the band before it
   can be counted again.
2. **The crawler stalled in a 1 m oscillation at each landmark.** The snap-back to the
   authored arc fought the forward step, so coverage read **10.7%** of a 28 m conduit
   and nothing anywhere looked wrong. Same root cause as (1).
3. **`driftRatePer10m` was not a rate.** It returned `mean(error) × 10` — the mean
   correction scaled by an arbitrary ten, which grows with *landmark spacing* rather
   than with the drive train's error. It reported **1.15 m per 10 m** on a conduit whose
   uncorrected drift was 0.22 m per 10 m: a measured drift larger than the drift it was
   measuring. Now normalised by distance actually crawled between closures.
4. **The landmark detection band swamped the signal.** A landmark fires on proximity,
   so the correction is drift *plus* the offset the agent happened to be at inside the
   band. At the original 12 cm the offset dominated a 6.4 cm drift over an 8 m leg. Now
   4 cm — still wider than one 0.9 cm tick of travel, so it cannot be stepped over.
5. **`canEnter` let a small-bore crawler into the 120 mm extract.** `medium || small`
   for every class, which inverts the nesting: `crawl.medium` implies `crawl.small`, not
   the reverse. A crawler that could handle 40 mm would have wedged in a duct it cannot
   turn around in — the exact failure `irreversibleRisk` exists to prevent.
6. **Two routing entry points, one of them lying.** `routeToArc` patched the final arc
   after the fact but recomputed length against the *unpatched* figure, reporting
   **28.3 m for a 2 m hop** on a loop. Collapsed to one function.
7. **`EventLog.byKind` returned `never`.** `SimEvent.kind` is a union on a single type,
   not a discriminated union of variants, so `Extract<SimEvent, { kind: 'x' }>` is
   `never` and every caller got an unusable signature — the narrowing that looked like
   it was doing something was deleting the type.

Plus two design errors found by the parity pin rather than by a test:

8. **A pipe penetration was a ventilation register.** `detectBlockedVent` selected ports
   by "one side is ground", which Stage E's five new constrained↔ground ports all
   satisfied. It fired at the boiler flue — **one metre from the real blocked vent it
   was already detecting**, a true positive reached for entirely the wrong reason, which
   is worse than a miss because it survives a precision check. Fixed by authoring
   `Port.kind` (`vent` / `conduit_entry` / `hatch`) rather than inferring purpose from
   geometry. See §11.23.
9. **A crawler was invisible to the viewer.** `frameFromRun` cast every pose to
   `{x, z}`. A lumen pose has neither, so `x` was `undefined` → `NaN` in the vertex
   buffer → the agent silently vanished, which looks exactly like a crawler that has
   not started yet. Now projected through the lumen graph **at the frame boundary**, so
   the sim core still knows nothing about presentation.

#### A parity pin that moved, and what it cost

The Stage-D pin `2923fbf7` failed on the first Stage-E run. Rather than bump it, the
log was split into per-kind hashes to find *which* events moved: one extra
`anomaly.candidate`, at tick 860, at the position of a new port. Reverting the five
ports alone restored `2923fbf7` **exactly** (612 → 613 events).

So the pin was not stale, and bug (8) was a real regression that a coverage assertion
would never have caught — every metric was unchanged: tick, coverage, job tally
(40/31/9) and energy (1.0665 Wh) all identical, with one phantom finding added. The pin
is still `2923fbf7`, unmodified, and the fix is what moved it back.

The general rule, now earned twice: **an all-or-nothing hash tells you *that*
something changed; only splitting it by kind tells you *what*.**

#### Two content errors the validators caught on first contact

Worth recording because both were invisible to the running simulation:

1. **`waste-sink` was authored as a loop.** It carried the same port at both ends while
   its polyline ran 1.9 m away. The graph built, the router worked, and the agent would
   have crawled the full traverse and found no exit — which is the *only* way S5's
   irreversible case is real. The validator's "a loop must close in the geometry" check
   refused it on the first load, and it was re-authored as a genuine dead end.
2. **`duct-drop-utility` sat at y = 0.4.** Every conduit is authored in its own
   coordinates and the void runs at floor level; a 0.4 m discrepancy between the port
   and the pipe it serves is a coordinate error that nothing downstream would notice.

---

### 11.23 Ports declare their purpose, because geometry does not imply it

Stage E added `Port.kind`, and the reason is worth its own section because it is a
rule, not a field.

The first version inferred a port's purpose from its manifolds: "if one side is
ground, it is somewhere a ventilation fault can occur." That is how a **boiler flue
penetration** became an air register and the blocked-vent detector fired one metre from
the real defect it was already finding. The finding was correct and the reasoning was
wrong, and it is worse than a plain miss because a precision check passes it.

So:

| Kind | Means | The air field means something here? |
| --- | --- | --- |
| `vent` | an air register | yes |
| `conduit_entry` | a bore the crawler can enter | no — a VOC reading beside a pipe penetration is not evidence of poor extraction |
| `hatch` | a passage between spaces | air flows, but it is not a register |

`kind` defaults to `vent`, so every Stage A–D port keeps its meaning and no earlier
fixture changes. The loader rejects an unknown kind, and rejects `conduit_entry` on a
port with no constrained side — because the declared purpose is the only thing keeping
the blocked-vent detector off a penetration, so a contradiction there would silently
disable it.

**The rule:** a port's manifold pair says which manifolds touch. It does not say what
the thing is, and inferring purpose from geometry is how a detector ends up right for
the wrong reason.

---

### 11.24 A false zero in the safety monitor, found four stages late

Stage E part two. The gate reads *"Inchworm findings hand off at a port and get
confirmed"*, and the honest position is that this section does not deliver it � it
delivered three bugs that were standing underneath the attempt.

#### The stranded detector had never run

checkStuck was exported, looked correct, and was **called from nowhere**. And the
stalledTicks it accepted was a boolean (moved < 0.001 ? 1 : 0), not a count, so
even a caller would have handed it 1 where it expected 200.

stranded: 0 had been printed in every run since Stage A. It was not measuring
anything. It was a counter nobody incremented, in the one monitor whose entire job is
noticing that a robot has stopped moving.

It was found by accident, which is the worst way to find it. A field change perturbed
the trajectory and the ground bot wedged in a gap at a byte-identical pose for **2500
ticks**; coverage froze at **63.83%** against a 100% baseline, and stranded still
read 0. So the monitor's silence was not evidence of a healthy swarm � it was the
absence of a monitor. **That is the �11.22 bug class one level up, and it had been
sitting in the one place a false zero does the most damage.**

Fixed: a real counter on AgentState, a reachable threshold (STALL_LIMIT_TICKS =
100, ten seconds), and recovery that *changes the situation* � abandon the plan,
release the job as failed, reset the counter. Replanning from the same pose produces
the same path through the same gap, which is exactly how the agent walked into it for
2500 ticks.

	est/scenarios/stranding.test.ts builds the wedge deliberately, because the default
trajectory produces none and a wedge that only happens on one seed is a wedge that
will silently stop happening. It asserts the counter accumulates, that gent.stranded
fires, that the job is released rather than abandoned, and that **the parity hash did
not move** � a fix to a monitor must not change the simulation.

#### Two accounting holes found alongside it

- **jobTally.awarded was never incremented.** Five job.awarded events, a tally
  reading 0. A field that exists, is printed, and is always zero.
- **Unfinished work vanished at mission end.** A crawler part-way down a 28 m conduit
  at tick 3000 left its job ctive with nobody holding it. closeOutJobs now marks
  it ailed � announced work the swarm could not finish in the time given is not the
  same as work never announced, and the tally is where that shows.

#### A change I made, measured, and reverted: manifold-scoping the fields

While looking for the wedge I found that uildField fed *every* anomaly into the
ground fields regardless of manifold, and I fixed it � on the reasoning that a
blockage inside a sealed duct should not raise the VOC proxy in the room above it.

It cost the baseline. Measured, properly, by relabelling every anomaly as
ground-manifold so the filter could not reject it:

| | |
| --- | --- |
| temperature cells changed | **1034 of 1536** |
| max temperature change | **11.3 K** |
| pest_indicator recall | 1.00 ? **0.00** |

Four authored anomalies are labelled constrained � ml-04, v-02, v-03,
pi-02 � and **that is simply where they were put**, while their thermal signature
is what the ground-plane sensors were authored to detect. manifold records where a
defect *physically is*, not what can *sense* it.

So the filter did not correct a modelling simplification; it deleted authored content
and presented the deletion as a fix. Reverted, baseline restored exactly
(2923fbf7, 40/31/9, 1.0665 Wh, all six per-class metrics identical), and the real
limitation is written into ields.ts where the next person will hit it.

Two lessons, both earned:

1. **An isolation harness whose arms differ only in a flag is not an isolation
   harness.** The first attempt at this measurement reported "scoping changed
   nothing" and was false: uildFields defaulted its manifold argument to ground,
   so the "unscoped" arm built the scoped field. Both arms were identical by
   construction and the comparison was theatre.
2. **Four edits at once is four unattributable outcomes.** The regression appeared
   while I was fixing the stall monitor, and the plausible-looking cause was wrong.
   Measure one edit at a time, even when the edits are individually small and even
   when you are confident.

#### Failure handoff (spec �6.4 mechanism 3), and a hazard it creates

Released a stranded agent's job and excluded it from that region for 30 s, so the
frontier policy cannot hand the same unreachable gap straight back.

Measured, and the first version was actively harmful: **a global ban with one agent
benched the only robot for half a minute.** Jobs completed 31 ? 17, starvation 9 ? 47
� every one of those extra failures caused by the *recovery*, not the fault.

So the exclusion is scoped to the region (the knowledge being encoded is "this robot
cannot get through *there*") and is skipped entirely when withholding the agent would
leave the job with no possible bidder. In a swarm a global ban is merely wasteful;
with a single agent it is paralysis.

---

## 12. Explicitly cut, with reasons

| Cut | Reason |
| --- | --- |
| RGB sensing in v1 | §4.6 — 3× perception budget for 6 of 21 anomalies; deferral rule stated |
| Physical recombination (docking) | §7.1 — attachment kinematics is not the thesis; logical composite is testable |
| Aerodynamic hover model | Thrust-vectored kinematics suffice; drag modelling changes no decision under test |
| Real crack/pest classifiers | Geometric proxies until RGB lands; metrics flagged pessimistic |
| Multi-agent learned behaviour | The thesis is about *architecture*, and a learned policy cannot be argued from one seed |
| Comms packet loss / bandwidth limits | Latency and partition are modelled; loss is a second-order effect |
| Multi-house environments | One house, varied scenarios. Environment variety is test data, not content |
| Failure injection beyond the listed fallbacks | Enough to test coordination; a full FMEA is a different document |
| Ground bot arm / under-furniture manipulation | Low-clearance chassis (0.11 m) reaches the voids; a manipulator is a different product |

---

## 13. Known limits

Stated now, before the numbers exist, so they are read as design facts rather
than as excuses discovered later.

1. **Anomaly fields are synthetic.** Detection accuracy measures the pipeline,
   not sensor physics. Real moisture and thermal fields are far noisier and less
   separable. Every accuracy number here is an **upper bound**.
2. **The inchworm's closure will be measurably worse than the ground bot's.** It
   has no 2-D structure to match against. This is a property of confined-space
   SLAM, not a bug, and the metrics must show it rather than hide it.
3. **Pseudo-vision.** With RGB cut, cracks and pest indicators will over-fire.
   §4.6's deferral rule exists to stop v2 numbers being compared against these.
4. **Simulated navigation is optimistic.** No wheel slip, no real obstacle
   recovery, no actuator failure, no dust or darkness. Coverage figures are
   against a map that is easier to build than a real one.
5. **Fusion residual understates inconsistency** in the partition case, because
   the coordinator is holding chunks it cannot currently register. §S7 exists to
   measure the size of that understatement.
6. **Correlated-error handling is the least-tested part.** The covariance
   discount in §7.1 is specified but is the piece most likely to be
   implemented optimistically. It gets its own test in stage H.
7. **`structural_crack` is undetectable at Stage B, for two structural reasons.**
   (a) The detector is geometric — it resolves a thin, isolated, linear obstacle
   and cannot resolve a hairline crack *in a wall surface*, which is what most real
   cracks are. (b) A feature thin enough to be proxy-detectable is thinner than
   the navigation inflation band: a 0.10 m pier in a 0.05 m grid with 0.20 m
   clearance becomes a 0.50 m exclusion, and the robot wedges against it.
   Authored geometry for these instances was tried and removed for that reason.
   **The general finding is worth more than the class: a defect the robot cannot
   get close enough to see is a defect it cannot report, and the navigation mask is
   what prevents it.** Two of three crack instances therefore score 0 recall, and
   the class is reported as a visible limitation rather than as a measurement. A
   physical fix is a lower-chassis sensor or a pole camera, not a better detector.
8. **Precision, not recall, is the weak axis at Stage B** — 22 false positives per
   run, with per-class precision between 0.25 and 0.50. Spec §13.1 says these are
   upper bounds; this is the first stage where the bound is visible in a number, and
   it is worse than "optimistic". The causes are known and separate: deferred RGB
   (clutter, crack), a biased range estimator (thermal localisation), a lagged
   scalar sensor with no bearing (moisture), and association that merges approach
   duplicates but cannot yet merge a broad source's sightings.
9. **The thermal sensor has no height.** It has a bearing and a range but reports
   a fixed 0.6 m altitude, so a ceiling-vent anomaly is found and placed at chest
   height. Measured as `thermal_anomaly` extent IoU 0.03 — F1 says "found", IoU says
   "found the right thing at the wrong altitude". A report carrying only F1 would
   send an operator to the right room to look at the floor.

---

## 14. Open questions

Blocking nothing at Stage A; each needs an answer before the stage named.

| # | Question | Needed by |
| --- | --- | --- |
| 1 | Does the hover bot's 1.0 m ceiling clearance make the attic unreachable in practice, or just expensive? | F |
| 2 | Is `capacity` (vs. `capability`) in the bid score redundant given the eligibility gate? | C |
| 3 | Should `resolve_contested` be a job type or a coordinator-only action? If jobs can be *generated by the map*, the coordinator is more than a market-maker. | G |
| 4 | What is the acceptable false-positive rate for a real inspection? §9.2 measures it but nothing sets the bar. Measured 22 per run at Stage B. **Now the most valuable open question in the project**: at some point recall 1.00 with 22 false positives is no longer useful to a human reader, and where that line sits depends entirely on whether recombination (Stage H) or vision (v2) lands first. | B — now open |
| 7 | The thermal sensor has no height estimate (§11.4.9). Does v2 add a stereo/structured-light altitude, or does the hover bot cover ceiling work and the ground bot is simply not tasked with it? | F |
| 5 | ~~Is per-agent IMU bias calibration a v1 capability?~~ **Resolved 2026-10-01.** Yes: one-shot, imperfect (15% → 60% residual), re-obtainable at a cost. Spec §4.5.1. Chosen because no calibration overstates drift and misrepresents a modest real IMU, while a perfect one deletes the drift phenomenon the project exists to study. | — |
| 6 | Does drift decay make recalibration a worthwhile auction cost, or does closure just absorb it? Not answerable on paper. | E |
| 8 | **How much does the job system cost, and what does it buy?** Stage C measured +33% energy for verification trips and one class lost its recall. Both sides of the trade are now known; which side wins needs the second agent. | E |
| 9 | ~~The coverage-job policy announces the first unobserved cell in scan order.~~ **RESOLVED 2026-10-02**: replaced by frontier-region ranking (spec §11.17). Job churn 126 → 19 per 300 s, starved 18 → 9, and `pest_indicator` recall recovered 0.00 → 1.00. | — |
| 10 | The viewer makes regret legible but cannot evaluate it: with one agent it is identically zero. **Stage E is the first stage where the auction's worth is decidable**, and S8 has to be re-run there before anything else. | E |

---

## 15. Deliverables map

| Brief § | Deliverable | Documented in |
| --- | --- | --- |
| 10 | Engine / platform | §1.1 |
| 1 | Simulation architecture | §1 |
| 1 | Environment layout | §2 |
| 2 | Agent definitions | §3 |
| 3 | Sensor models | §4 |
| 4 | SLAM module | §5 |
| 5 | Job system | §6 |
| 6 | Swarm coordination | §7 |
| 7 | Inspection report | §8 |
| 9 | Test scenarios | `test-scenarios.md` |
| 8 | Evaluation metrics | §9 |
10. **The constrained manifold is not connected, and the simulated swarm's reach
    is smaller than it looks.** The six conduits form **four** disconnected
    components (11.22). A single inchworm can only ever survey the component its
    home port sits in, so the constrained-manifold coverage figure is a function of
    one configuration value rather than a property of the swarm. Any thesis claim
    about "inspects the pipes" must be reported per component until either a second
    crawler is homed in another, or an agent that can carry work between components
    exists. Recorded now because the single-crawler number is otherwise
    indistinguishable from a swarm-wide one.
11. **The inchworm's constrained-manifold sensing is a placeholder.** It advances a
    humidity lag filter and records traversal, but it samples no constrained scalar
    field - because no such field exists yet, and sampling the *ground* field at the
    pipe's world position would give the crawler a free teleporting view of the
    manifold the split exists to deny it. So the crawler's inspection value is
    currently coverage and localisation, not detection: it finds nothing, by
    construction, because it has no thermal sensor. The honest statement is that
    Stage E proves the crawler can *get there*, not that it can *do anything once
    there*.
12. **Loop closure is bounded by authored landmark spacing, and that spacing is
    uneven.** worstCaseDriftBound shows a 14.84 m unfixed stretch on the
    under-floor perimeter void - 11.9 cm of uncorrected drift at 0.8% scale error,
    against a 0.12 m arrival tolerance. So the bound is real and the content is not
    yet good enough to sit comfortably inside it. The metric is reported rather than
    the content tuned; see test-scenarios.md gap 11.
13. **Regret remains unevaluable, so the auction is still unjustified.** Not a bug
    and not yet a result. Two agents exist and neither has ever been contested by the
    other, so the 2% kill condition has never been consulted. Until two agents share
    a manifold, the auction's entire cost is being paid for an unmeasured benefit.
---

### 11.25 Capability handoff � the second half of Stage E's gate

The gate reads *"Inchworm findings hand off at a port and get confirmed."* This is the
part that was missing, and building it turned up a constraint I had removed myself.

#### I had granted the crawler a sensor it does not have

sense.humidity was on INCHWORM from the first version of Stage E. Spec �3.2's
capability list is crawl.small, crawl.medium, sense.depth, sense.imu,
map.graph, map.merge � and humidity is not on it.

The symptom was benign: a crawler reading a field it had no business reading, and
raising nothing, because the reading was sampled at the origin and discarded. The
cost was not that. It was that a scalar sensor would have let the crawler **partly
corroborate its own findings**, so spec �6.4's escalation would never have fired, and
the constraint that makes capability handoff necessary would have been quietly
removed by a change that looked like a missing feature.

Removed, with the reason kept inline in 	ypes.ts so the next reader does not put it
back. What the crawler has is sense.depth, so **the only finding it can raise is
geometric** � something is in the way � and it cannot say what.

#### The chain, end to end

| | |
| --- | --- |
| world/bore.ts | forward range down the bore. Not scanDepth: a pipe has no grid and one degree of freedom |
| sim/constrained.ts | constrained.obstruction detector; one blockage is one finding |
| un.ts escalate | each suspicion ? erify_thermal at the **nearest port**, ground manifold |
| un.ts corroboratingCandidatesNear | a thermal-capable agent samples the penetration |

Suspicion confidence is CONDUIT_SUSPICION_CONFIDENCE = 0.4, deliberately **below**
CONFIDENCE_MIN = 0.6, and the relationship is asserted by a test rather than left in
a comment. A range finder bouncing off something can say "there is something there"
and nothing more; any confidence it could honestly assert would be a claim about a
sensor it does not have. Raising it would silence the crawler's entire contribution
**and look like an improvement**: more precision, identical recall, one less agent
doing anything.

Measured, with the crawler homed in the utility room:

| | |
| --- | --- |
| bore obstructions in reach | 2 |
| crawler suspicions | 2 |
| handoffs raised | 2 |
| handoffs worked by a thermal-capable agent | 2 |
| **confirmation rate** | **0%** |

#### The confirmation rate is 0%, and it is structural

Not a tuning failure, and � this is the part that matters � **not a broken test**.
There is a test that proves the corroboration logic can confirm when the evidence
exists (can confirm when the evidence is there � so the 0% is about the world, not the
code). Without it, "the rate is 0%" and "the mechanism is broken" are the same
sentence, and only one of them is true.

Two independent reasons, both structural:

1. **The corroboration test reads thermal candidates, and in-bore obstructions have no
   thermal signature.** They are authored with sourceStrength: 0 because an
   obstruction is geometry, not a heat source. Authoring them with a signature would
   have moved the ground thermal field and broken the parity pin � and would have
   improved the headline number by changing the world so the answer came out right.
2. **The only other signal a blockage produces is stagnant air, and detectBlockedVent
   only checks it at air registers.** Port.kind marks all five conduit entries
   conduit_entry, deliberately (�11.23), because inferring "ventilation register"
   from "one side is ground" made the detector fire at a boiler flue one metre from a
   real blocked vent.

So the honest reading is: **a suspicion can be raised, escalated and worked, but on
this content it can essentially never be corroborated from outside the pipe.** The
defect is 6.5 m away behind a sealed duct wall, and nothing in a room is a sensor for
that.

**Open question, recorded not resolved:** should a conduit entry count as a *partial*
air register � a place where a blockage does cause measurable stagnation � while still
being excluded from ventilation *register* checks? That is a real modelling decision,
and this project's answer to it must not be "raise the number".

#### The oracle grew by three, and the ground baseline did not move

ob-01, ob-02, ob-03 � three in-bore blockages, all with sourceStrength: 0, all
placed far from any ground vent port. The reference run still hashes to **2923fbf7**
with tick 3000, coverage 100.00%, jobs 40/31/9 and all six per-class metrics identical.

That is the property worth having: **content on the constrained manifold can be
authored without perturbing the ground manifold's evidence**, so the two are
independently authorable. It is asserted by a test, because the whole mechanism rests
on it and a future edit that moved an obstruction near a vent would quietly invalidate
every ground measurement.

#### Bugs and dead tests found along the way

1. **escalate decided once per tick, not once per handoff.** Two handoffs reported
   **26 unconfirmations**, because the verdict was recomputed every tick the job sat in
   its bid window. A rate over re-decisions is not a rate.
2. **The no-silent-detector guard could not see a crawler detector at all.** It runs
   ground-only, so constrained.obstruction emitted nothing. The tempting fix was to
   add it to EXPECTED_SILENT � which would have been wrong twice over, since an
   allow-list entry means "this emits nothing and that is fine", and this detector
   works. Instead every detector now **declares the scenario it needs** and is checked
   against a run that has those agents, with the declaration itself asserted
   load-bearing (a crawler detector must be silent without a crawler *and* fire with
   one, or the declaration is decoration).
3. **Three S3 assertions and two inchworm assertions encoded the previous stage's
   state** � "holds 21 anomalies", "the crawler raises no findings". Both were true
   while the crawler had no instrument and both are false now. Updated rather than
   deleted, and the replacements assert something stronger: the crawler contributes
   nothing to the *ground* manifold, and everything it does raise is geometric,
   unverified, and below threshold.
4. **A test of mine asserted two Maps were identical by reference**, which is always
   false. Replaced with a determinism comparison, which is the claim that was meant.

---
---

### 11.26 The kill condition fired, and the scoring function is gone

The scenario this project was built around. Spec �9.4 pre-registered the condition:
**if mean allocation regret is under 2% across 20 seeds, delete the auction and keep
greedy.** It has now been measured.

#### Regret was 0.00% for five stages, and every one of those zeros had a structural cause

Not one of them was a measurement.

| stage | agents | why regret could not be read |
| --- | --- | --- |
| C | 1 | it wins every job it is eligible for, so regret is zero *by construction* |
| D | 1 | same |
| E | 2 | different manifolds - the ground bot cannot crawl and the crawler cannot drive, so they never bid against each other |
| E+3 | 2 | atteryHeadroom read **1.0 for 100% of bids** and currentLoad clamped flat, so three of five terms were constants |
| E+4 | 2 | regret was finally evaluable, and it was **still zero** |

That last row is the finding, and it took a second ground bot to reach.

#### The precondition: two agents that can bid for the same job

The hover bot cannot supply it - no ground.drive, volumetric manifold. So the only
way is a second ground agent, and that is not a contrivance: **S9's "all-ground" swarm
is three of them**, so the configuration has to exist anyway.

Docked 10.38 m away in the kitchen, verified passable against the authored grid and
asserted by a test. Two bots at one dock walk in formation and never contend, so the
allocator would look evaluated while measuring nothing.

#### The measurement

20 seeds per arm. All three arms have enough contested awards to read.

| arm | mean | p95 | worst | contested | winner was **not** the nearest |
| --- | --- | --- | --- | --- | --- |
| nominal | **0.000%** | 0.000% | 0.000% | 243 | **0 of 620 samples** |
| 30% battery (S6 6c) | **0.000%** | 0.000% | 0.000% | 243 | **0 of 620 samples** |
| with the crawler | **0.023%** | 0.000% | 23.84% | 314 | **1 of 1024 samples** |

**One award in 1024 went to the farther bidder.** The five-term score was not
approximately greedy; it *was* greedy to within one award in a thousand.

Two of the five terms could never have discriminated at all, and this is structural
rather than a matter of tuning:

- **capabilityFit was redundant with eligibility.** Every eligible agent scored 1 and
  every ineligible one 0, but eligibility() already refuses the ineligible ones, so
  within the bidding set the term was a **constant**.
- **irreversibleRisk had no competitor to lose to.** The inchworm is the only agent
  holding crawl.*, so on any conduit job it was the sole eligible bidder and a
  penalty changed nothing.

#### What was deleted, and what was kept

Deleted: SCORE_W, and the weighted score on Bid. id.submitted and
job.awarded now log distance, battery headroom and irreversible risk.

Replaced by two rules and no weights:

1. **Nearest eligible agent.**
2. **An irreversible-commitment veto** that loses at *any* distance.

The veto is the interesting part. It was a -2.0 weight, which is weaker than it
looks: the positive terms summed to 5.7, so a nearby enough 40 mm trap would still have
won the bid. **As a rule it cannot be outbid** - deleting the scoring function made the
safety property *stronger*, which is the one way a kill can be a good outcome.

Kept deliberately:

- **The protocol.** Announce, bid, award, monitor, starve, escalate. Not what the kill
  removed, and still load-bearing.
- **llocationRegret and uctionVerdict.** This decision is provisional on
  evidence. S9 compares a heterogeneous swarm against an energy-matched homogeneous
  one, and if capability-aware allocation earns its keep anywhere it is there. **A
  verdict that cannot be revisited is a verdict that cannot be overturned.**

Re-introducing a weighted score needs the evidence that removed it.

#### The parity pin moved twice, and behaviour did not

2923fbf7 ->  7520de4 (normalisers fixed) -> 8f9dfce8 (score deleted). The score
was dominated by distance, so deleting it changed no award:

| | value | across all three hashes |
| --- | --- | --- |
| tick | 3000 | identical |
| coverage | 100.00% | identical |
| jobs | 40 / 31 / 9 | identical |
| per-class metrics | all six | identical |
| energy | 1.0665 Wh | identical |

**A hash tells you the bytes changed; it does not tell you whether the simulation
changed.** The behavioural invariants are now pinned separately in
ng-and-replay.test.ts, and they are the part of the reference that can be verified
without a browser.

**And the current pin is not browser-verified.** The available browser tooling cannot
execute page script and does not expose table cell text through its accessibility
snapshot, so the viewer's hash cannot be read. The structural claim - one
implementation imported by both paths - holds and is enforced by

o-render-imports.test.ts; what is missing is the byte-level cross-engine check,
which is the whole point of the pin. Recorded as an open liability rather than papered
over.

---
---

### 11.27 S9, and the target it produces for the recombination mechanism

#### First: the thesis is not what I nearly tested

The thesis is **"a heterogeneous swarm pays only if recombination helps evidence"**. It
is **not** "heterogeneous beats homogeneous". Those are different claims, and the first
one has a built-in consequence: **capability without recombination should lose.** So S9
as far as it can currently run is a **control arm**, not a test, and a loss there is
predicted rather than surprising.

What a control arm is for is turning "it lost" into "here is the number the real
mechanism has to beat". That number is below.

#### The specced comparison was confounded by 58%, and my fix reproduced it almost exactly

	est-scenarios.md S9 says both arms are 72 Wh. They are not:

| arm | composition | energy |
| --- | --- | --- |
| H heterogeneous | ground 38 + inchworm 12 + hover 22 | **72 Wh** |
| A all-ground | 3 x ground | **114 Wh** |

The all-ground arm carries 58% more energy than the heterogeneous one, while the note
under the table claims "matched energy, not matched headcount of capability". The
arithmetic matches nothing.

So the arms were re-matched on energy *and* headcount - H is ground(38) + inchworm(12)
= 50 Wh, A is 2 x ground at 25 Wh = 50 Wh - using initialBatteryFraction = 25/38 so
that the arms differ in exactly one thing: capability.

**The first version of that fix set the fraction to 50/38 = 1.3158.** createRun does
clamp(config.initialBatteryFraction, 0, 1), so it silently became 1.0 and the arm
that was supposed to be energy-*handicapped* was granted 2 x 38 = 76 Wh. Measured: it
started with **74.50 Wh against H's 47.29 Wh - a 57% over-credit.** That is the spec's
58% confound reproduced to within a point, after having been identified and fixed.

This is the project's recurring failure mode one level up from the others: **a config
value that gets clamped is a value that is not the value you set**, and a matching claim
that is never checked against the granted result is decoration. The pin that catches it
is cheap - read gent.battery * agent.spec.batteryWh back out - and it is now printed
as a row in diag-s9.ts rather than asserted in prose.

Corrected, the granted packs are **47.34 Wh vs 48.44 Wh**, a 2.3% gap that is the IMU
calibration draw, not a design difference.

#### Correcting it moved no result, and that is a second finding

The re-run returned identical numbers, which is suspicious in the opposite direction: if
the clamp had really been handicapping the arm, fixing it should have moved something.

It moved nothing because **energy is not a binding constraint on the ground manifold at
300 s**. The ground bot spends **2.87% to 3.33%** of its pack. No pack size in this range
binds.

So there are two separate findings, and only one is about the code:

1. The clamp was a real defect; the arms were not matched as claimed.
2. The whole energy-matching exercise - mine and the spec's - was never going to bind at
   this mission length, so a 57% energy advantage changed nothing at all.

A confound that is repaired and changes nothing is a different fact from one that is
repaired and changes everything, and only running the corrected version tells them
apart.

#### The ceiling: 2 defects, and that is a fact about the house

Only three of the seven constrained defects have a conduit target at all, and the
constrained manifold is four disconnected components. Measured per home port:

| home port | enters | ceiling |
| --- | --- | --- |
| duct-drop-utility | void-perimeter | **2 of 3** (ob-01, ob-02) |
| sink-tail | waste-sink | 1 of 3 (ob-03) |
| cavity-entry | cavity-kitchen | **0 of 3** |
| flue-entry | nothing | 0 of 3 |

So H's constrained ceiling is **2 defects**, and both carry sourceStrength: 0, which is
the structural reason in-bore suspicions corroborate so poorly: an obstruction inside a
bore contributes nothing to any scalar field, so no agent outside the pipe has
independent evidence to offer, and a conduit entry is not an air register.

#### The measurement: 30 seeds, paired on seed

| metric | H (ground+crawler) | A (2 x ground) | paired |
| --- | --- | --- | --- |
| starting pack granted, Wh | 47.34 | 48.44 | - |
| ground anomalies confirmed | 9.33 | 10.17 | A better 22, H better 0, tie 8 |
| ground false positives | 19.40 | 16.77 | A better 28, H better 0, tie 2 |
| ground coverage @60 s | **68.73%** | **95.50%** | A better **30**, H better 0 |
| constrained coverage | **49.41%** | 0.00% | H better **30**, A better 0 |
| constrained candidates raised | 2.00 | 0.00 | - |
| of those, confirmed at a port | **0.23** | 0.00 | - |
| energy actually used | 2.659 Wh | 1.559 Wh | A better 30, H better 0 |
| confirmed per Wh actually used | 3.611 | 6.529 | A better 30, H better 0 |

**P1 fails. Putting a crawler on the board costs 26.77 points of ground coverage on 30 of
30 seeds**, and buys a ceiling of 2.

Note that "H never wins" would have been the wrong summary. H is ahead on **5 of 30**
seeds and tied on 4. The claim is about the mean, and the spread is why: a capability
that converts 11.7% of its suspicions into evidence cannot show up reliably on any
single seed.

#### One prediction had to be amended, and it is recorded as an amendment

P2 and P4 were first measured against ground coverage at the 300 s mission, where
**both arms score 100.00%**, because coverage saturates at 120 s (measured 39.54% at 30 s,
68.82% at 60 s, 97.79% at 90 s, 100.00% from 120 s). A metric pinned at its ceiling
carries no information, so both were re-registered against a 60 s mission.

This repairs a broken measurement rather than moving a goalpost: neither prediction ever
made a claim about mission length. It is recorded as an amendment because the
distinction matters - a prediction changed to match its result is not a prediction.

#### The target, which is the point of the whole exercise

| | |
| --- | --- |
| ground confirmations given up | 0.8334 |
| constrained ceiling reachable | 2 |
| **required in-bore confirmation rate** | **41.7%** |
| **measured in-bore confirmation rate** | **11.7%** |
| **shortfall** | **3.6x** |

So Stage H has a number to hit: **the recombination mechanism must convert in-bore
suspicions into confirmed evidence at 41.7%** for the crawler to justify itself on this
house, against 11.7% today. And that break-even ignores the 26.77 pp coverage loss, so
the real target is higher.

If Stage H cannot reach it, the honest conclusion is that **this content does not support
a crawler at all** - a finding about the house, and worth having before Stage I puts a
third agent into it.

#### What this section is not

No hover bot exists (Stage F), so A has no answer to ceiling or attic work and was never
offered one. No recombination clusters exist (Stage H), so nothing here can test the
thesis. No volumetric manifold exists (Stage I), so neither arm can work above floor
level.

What it establishes is the bar. At matched energy and matched headcount, **spending
12 Wh on a crawler instead of a second ground bot costs ground coverage outright** -
which is the correct and expected outcome for capability without recombination, and the
reason the recombination mechanism now has a target rather than an argument.
---

### 11.28 Stage F part zero, and the finding that reframes it

#### I nearly built a hover bot whose defining constraint never binds

The stage F gate is "ceiling rasters at =0.6 confidence; hover endurance respected by
allocation". Before writing any of that, I read the content the gate would be measured
against. Four defects, none of which any test had caught:

| defect | what building on it would have produced |
| --- | --- |
| **no attic anywhere** � all 6 rooms 2.5 m, zero obstacles with maxY below 2.0 | the hover bot's 1.0 m ceiling clearance **never binds**. Spec open question 1 ("unreachable, or just expensive?") becomes unanswerable, and the agent's single most important number is decoration |
| shaft-cap-garage at **y = 4.0** in a world whose maxY was 2.6 | a port *outside the world*, declared volumetric-to-volumetric, carried through all of Stage A-E. Routing through it flies into empty space and nothing fails |
| zero overhead geometry � no obstacle with minY above 1.5 | a volumetric sensor looking up sees only a room's maxY. A ceiling raster has nothing to raster |
| only 1 of 3 volumetric defects had an eligible sensor | ml-03 needs sense.humidity (no volumetric agent has it); sc-02 has sourceStrength: 0 and needs the deferred RGB path |

The first is the dangerous one, and it is the same failure this project has now found
five times: **a thing that returns nothing looks exactly like a clean result.** The
1.0 m clearance not binding would have read as "clearance costs nothing", which is the
opposite of the truth.

Fixed: world maxY 2.6 -> 3.6; an ttic room at y 2.6-3.5 giving **0.90 m** headroom
over the hall, against a 1.00 m clearance. The ceiling between them is *implicit* � rooms
stop at 2.5, the attic starts at 2.6, so the 0.10 m slab is in no room and is therefore
solid. A hatch-opening room punches a 1.0 x 1.0 m hole through it, and
hatch-attic-stair moved from [4.0, 0.0, 3.4] (a hatch at floor level in a house with no
attic) to [-2.9, 2.55, 0.0], in the hole.

olumetric.ts then had a bug of its own, caught by its first probe: headroomAt
returned the column **total**, 3.50 m, when headroom means the tallest thing that fits.
Split into reeRunsAt (all contiguous free stretches) and headroomAt (the tallest),
because a bot cannot use both the hall run and the attic run.

#### The finding: the volumetric manifold has no scalar field, so nothing on it is private

I authored 	a-06 � an attic solar-gain thermal defect, 13 K at y = 3.0, named in spec
�4.4's own 	hermal_anomaly list, squarely inside the low run. It sat in the attic and
was supposed to be the thing that made the clearance cost something.

Its effect on the pinned reference run:

| | without 	a-06 | with 	a-06 |
| --- | --- | --- |
| jobs announced | 40 | **45** |
| jobs done | 31 | **36** |
| energy | 1.0665 Wh | 1.0001 Wh |
| log hash | 8f9dfce8 | 97d5ccef |

**A defect 3 m above the hall floor, detected by a robot that never left the floor.**

The cause is structural. The scalar fields are **ground-plane projections that ignore y**
(spec �5.2). �12 already records that manifold-scoping them was tried and reverted
because it rewrote 1034 of 1536 temperature cells and took pest_indicator recall from
1.00 to 0.00. So a defect authored on the volumetric manifold writes into the same field
the ground sensors read. Two defects 3 m apart vertically produce **byte-identical
fields**, which is now a test.

I removed 	a-06. Then I verified that removal restored the baseline exactly � hash back
to 8f9dfce8 � which also established that the attic, the bounds change, the port move
and the port deletion are **all inert** for the ground manifold. Only the defect moved
anything, and it moved it because it is invisible from above.

#### Why this reframes Stage F rather than blocking it

The consequence is narrow and useful: **an attic thermal defect does not justify a hover
bot, because the ground bot sees it through the floor.** So the hover bot's unique
contribution is ceiling **coverage** � surveying space that must be flown through � not
ceiling **detection**. Those are different claims, and only the second was tacitly
assumed.

It is also not obviously wrong physics. Thermal conduction means a hot attic really does
warm the rooms below, so a ground sensor reading an attic hotspot is defensible. What is
not defensible is using that as the hover bot's justification, because the justification
then does not require the bot.

Which is also why removing 	a-06 was right on the merits rather than merely convenient:
**authoring a prize in the attic and then concluding the hover bot must go and get it is
circular.** The attic is deliberately empty. Stage F measures whether ceiling work
justifies a 4.4x endurance penalty; it does not get to place the payoff first.

#### Recorded, not fixed

- **ml-03 stays undetectable.** Needs sense.humidity, which no volumetric agent has.
  Granting it would silently repair the fifth member of the structurally-undetectable
  family. The defect stays broken and visible.
- **A manifold-scoped field is the fix** and it was already tried and reverted.
  Reopening it needs the pest detector's manifold assumption fixed first, not a different
  filter.
- **In practice the volumetric manifold contributes nothing the ground manifold cannot
  already see.** 1 of its 3 defects is sensor-eligible, and that one leaks downward.
  That is the number Stage F has to beat.
---

### 11.29 Stage F part one: the volumetric manifold, and three bugs of my own

The content precondition (�11.28) made the clearance constraint testable. Building the
manifold on top of it turned up a model error and three bugs, all of which would have made
the clearance look cheaper or the routes look better than they are.

#### The model was wrong: ooms is decoration in this house

Free space was originally the **union of room AABBs**. Measured result: **six connected
components, one per room.**

| probe | raw cell |
| --- | --- |
| door-kitchen gap | VOXEL_OUTSIDE |
| door-living gap | VOXEL_OUTSIDE |
| door-bath gap | VOXEL_OUTSIDE |
| door-corridor gap | VOXEL_OUTSIDE |
| door-utility gap | VOXEL_OUTSIDE |

Rooms do not overlap at their doorways, so the gap between two rooms is in neither, so
every room was sealed inside its own walls and the hover bot could not leave the hall.

The 2-D grid does the opposite: uildGroundGrid stamps obstacles and then calls
illFreeSpace, so **free space is the bounding box and walls do all the separating** �
doorways are gaps in the wall boxes, which is exactly how house-01 authors them
(wall-w-bath-a stops at z = -3, wall-w-bath-b resumes at z = -2). Volumetric now does
the same, for the reason that matters: if two manifolds disagreed about where walls are,
no comparison between them would mean anything.

A consequence worth recording: **nothing in the codebase reads house.rooms except
validation.** house-01 is one open volume with partial wall furniture, and the room list
describes an intention the geometry does not enforce. So an attic cannot be authored as a
room � it has to be authored as obstacles. That is what ceiling-a..ceiling-d are: a
ceiling slab at y 2.5-2.6 in four pieces around a 1.0 x 1.0 m hatch, with the four
exterior walls raised to 3.5 to enclose the roof space.

After the fix: **1 component**, 180,642 passable voxels, all five doorways open, and the
attic reachable through the hatch and back out again.

#### Bug 1: body clearance reserved room that was not there

olumetricPassability dilated by the rotor radius but rejected only VOXEL_OCCUPIED �
authored obstacles. Room and world boundaries are not obstacles; under this model they are
simply "inside bounds", so nothing stopped the bot claiming clearance through the side of
the house.

Measured at the hover bot's 2 cells (0.20 m):

| dilation rule | passable voxels |
| --- | --- |
| obstacles only | 135,423 |
| anything not free | **113,035** |
| difference | **-22,388 (13.08% of all free air)** |

So 13% of the house's habitable volume was handing the bot 0.20 m of clearance through
surfaces that are not there. A room's edge is a wall whether or not an obstacle says so.

#### Bug 2: the waypoints were not voxels

econstruct3 and the heuristic decomposed the flat index with
iz = (idx - ix) / nx / ny, which is not an integer. Steps came out at **1.607 m** where
the longest legal 26-connected move is sqrt(3) x 0.10 = 0.173 m � so the "path" was a
sequence of teleports. With Math.floor, steps are 0.141 m and every waypoint is passable.

#### Bug 3: eached was a claim about something other than reaching the goal

Two ways it lied:

- A goal outside the world was clamped into the grid, a passable voxel found beside it, and
  eached: true returned with a 5.60 m path **into empty space**.
- A goal inside geometry � a job authored in a wall � got the nearest passable voxel and
  still reported eached: true, which would let the arrival test mark the job complete
  on arrival next door.

Now: an out-of-world goal returns no path, and eached means the goal voxel was expanded
and nothing weaker.

**The 2-D planner had the same latent shape** and was fixed the same way. That the parity
pin stayed at 8f9dfce8 across the fix is the proof it was inert rather than live � which
is exactly why it needed a guard rather than an assumption.

#### Clearance binds as a cost, not a wall � which answers spec open question 1

Open question 1 asks whether a 1.0 m ceiling clearance makes a low attic "unreachable in
practice, or just expensive". Measured, not assumed:

- The dilated mask leaves **0.50 m** of usable height in the 0.90 m attic.
- HOVER_CLEARANCE_M is 1.00 m.

So the bot **can fly into the attic**, and clearance then makes it expensive. That is the
spec's own reading � �3.3 lists "maintain altitude in a 0.9 m attic without cost penalty"
under *Cannot*, which permits entry and charges for it � and it is why
olumetricPassability deliberately does not consult the clearance. Folding it into
occupancy would have answered the question by fiat before anything was measured.

#### One implementation, not two

MinHeap moved from star.ts to 
av/heap.ts, imported by both planners. Copying it
for the 3-D case is how two implementations of a tie-break drift apart, and a tie-break is
precisely the thing that must not drift � the same reasoning as the existing

o-render-imports boundary test, applied at the size where it actually bit. Parity held
at 8f9dfce8 through the move.

#### The ground baseline did not move, and that was verified rather than assumed

Every change here is volumetric-only, so the pinned reference run should be untouched �
8f9dfce8, tick 3000, coverage 100.00%, jobs 40/31/9, energy 1.0665 Wh. It is. Worth
stating that the �11.28 ceiling work *did* change the baseline (via 	a-06) and this did
not, because the difference between those two outcomes is the whole reason the projection
leak was worth finding.
---

### 11.30 Stage F part two: the hover bot, and both of my endurance predictions were wrong

#### What is modelled, and what is recorded as cut

Spec �3.3 gives "full 6-DoF attitude". Implemented: **position and yaw controlled, plus a
tracked tilt magnitude** the power model reads. The reduction is deliberate and is listed
in �12:

- Tilt is not decoration. Holding station under a low ceiling means fighting induced
  downwash, and that cost is what decides whether the attic is *expensive* or impossible �
  which is spec open question 1.
- Not modelled: rotor mixing, aerodynamic cross-coupling, thrust-vector lag. A flight
  simulator would make the clearance cost emerge from the physics; here it is a stated
  function of the geometry, which is more honest than a crude integration pretending
  otherwise.
- **Ground effect is ignored.** A rotor near a floor gets a cushioning effect that *reduces*
  required thrust, so this under-charges low flight. Left out because it pushes opposite to
  the constraint under test, and a model that made low flight cheap as well as safe would
  understate the case for the clearance penalty.

#### The clearance model is a blockage ratio against the space *above*

	hrust ? 1 / (1 - span / H), where H is the gap between the rotors and the ceiling. It
needs no tuning constant because the physics supplies the shape, and it is unbounded exactly
where the physics is � a rotorcraft cannot hover in a space its rotors do not fit.
HOVER_CLEARANCE_COST is a dial at 1.0, the pure model, so an experiment can scale it.

**The first version divided by the height of the whole free run**, which charged the same
penalty at 0.3 m and at 2.2 m in the same room � measured at a flat 9.6% everywhere. What
matters is where the downwash goes, which is *above*:

| position | gap above | blockage | multiplier |
| --- | --- | --- | --- |
| living room, y = 0.3 m | 2.20 m | 0.109 | 1.12 |
| living room, y = 1.2 m | 1.30 m | 0.185 | 1.23 |
| attic, y = 2.9 m | 0.60 m | 0.400 | **1.67** |

This makes the penalty something the bot can *avoid by flying lower*, which is what turns
it into a decision rather than a location-dependent tax.

**And the worst clearance in house-01 is not the attic.** Flying at 2.00 m in an ordinary
2.50 m room leaves 0.50 m � tighter than the attic's 0.60 m � for a multiplier of 1.92
against 1.67. The consequence for the thesis: **a "low-ceiling room" is the wrong thing to
worry about. What matters is how high the bot flies, everywhere.** A planner routing by room
name would have kept the bot low in the attic and let it climb in the living room, which is
exactly backwards.

#### E1 and E2 were both registered, and both were contradicted

Registered before measuring:

- **E1 � the hover bot cannot run out on a 300 s mission.** *Prior: near-certain.*
- **E2 � therefore the endurance gate is not evaluable at the reference mission length.**

E1 is right about cruise and wrong in general, because the draw is altitude-dependent and
the penalty is not gentle near a ceiling. Measured in the living room at full tilt:

| altitude | draw | endurance | vs 300 s mission |
| --- | --- | --- | --- |
| y = 0.3 m | 111.3 W | 711 s | 2.4x |
| y = 1.2 m | 122.2 W | 648 s | 2.2x |
| y = 1.8 m | 151.7 W | 522 s | 1.7x |
| y = 2.0 m | 189.8 W | 417 s | 1.4x |
| **y = 2.2 m** | **462.6 W** | **171 s** | **0.57x - runs dry** |

**The binding condition is not "the hover bot is expensive". It is "the hover bot flies
high."** Below about y = 2.1 m in a 2.50 m room there is a comfortable margin; at 2.2 m there
is none at all.

E2 is therefore also contradicted, and the correction is *better* than the prediction: **the
gate is evaluable, it is just conditional on altitude rather than on the agent.** That is a
more useful gate than the one registered, because it says something specific � an allocator
that keeps the hover bot below ~2.1 m is safe, and one that does not is not.

Both are recorded as contradicted in stage-f-endurance.test.ts, with the prediction
paragraph kept intact above the corrected body so the two can be compared.

#### Where the model is extrapolating, and said so

At y = 2.2 m the gap is 0.30 m against a 0.24 m span, so blockage is 0.80 and the multiplier
is 5.0. That is where 1/(1-b) stops being a small-disturbance correction. The numbers
above 2.0 m should be read as "much worse", not as precision � and they are *not* smoothed,
because a fit that stayed gentle near b = 0.8 would have hidden the finding that the
constraint bites at all, and the finding is the useful part.

#### E3: endurance is respected by the capability filter, not by the ranking

This answers the gate's literal wording, and it reconciles with �11.26 without contradiction:

- �11.26 removed battery from the bid **ranking** because it measured inert. That was
  between two *identical* ground bots 10 m apart, neither of which could run out.
- Spec �3.3's capability list has **no ground.drive**, so eligibility() refuses every
  ground-manifold job on capability alone. The allocator never spends the hover bot on
  travel it does not need to make, because it never lets it bid.

A filter is a different mechanism from a ranking weight and a stronger one: a -1.0 weight
could be outbid by proximity, a capability cannot. **So the property �11.26 removed as
unearned is supplied here by a filter that was already there** � and the residual risk is
not allocation at all, it is altitude, which is the thing measured above.

#### Two spec corrections, measured

- **Spec �3.3 says the hover bot has "roughly 4.4x worse endurance" than the ground bot.
  Measured: 4.70x.** 38 Wh / 36 W is 3800 s against 22 Wh / 98 W is 808 s. A 7% error,
  corrected rather than left standing next to a test that disagrees with it.
- **Spec �5.4 says 0.10 m voxels**, and that is confirmed, but the clearance and dilation
  together mean the bot needs **1.20 m of vertical room** (1.00 m clearance + 0.20 m of
  body reservation). The 0.90 m attic therefore has 0.50 m usable, which is why the clearance
  is a cost rather than a wall.

#### The ban caught me

stepHover used Math.hypot, which ADR-001 �2.3 bans in the sim core. The
	ranscendental boundary test failed on it, which is the test doing exactly the job it
exists for on code written six stages after it was written. Replaced with hypot3 from
math.ts. Worth noting as evidence that the boundary test keeps working on new files rather
than only on the ones it was written for.
---

### 11.31 Stage F part three: volumetric sensing, and what the ceiling raster may claim

#### DDA, not a fixed step

castRay3 walks voxels with Amanatides-Woo traversal. Two reasons, both of them about
failures that are hard to see:

- **No tunnelling.** A fixed 0.05 m step can pass through a 0.10 m voxel without ever
  sampling its interior, so a thin obstruction is simply not there. DDA visits every voxel
  the ray actually crosses. A test sweeps 144 directions from a known-slab position and
  requires every one to report a hit.
- **Exactness.** The returned point is a voxel face found by comparison, not by accumulating
  float error over a march, so the same ray always returns the same distance to the last bit.

#### The depth sensor could not see the roof, and disagreed with the clearance model

A bug worth recording because it produced **two sources of truth for one fact**. An up-ray in
the attic returned *no hit*, so the depth sensor reported unlimited headroom in the one room
whose headroom is the entire point � while clearanceAbove correctly said 0.60 m.

Cause: free space is ounds minus obstacles, so the top of the grid *is* the inside of the
outer shell, and the shell is only partly authored as obstacles. The attic roof was the
bounds edge, not a surface.

Fix: leaving the grid is **hitting the world**, not escaping it. Consistent with the
horizontal case, where the exterior walls sit inside ounds so a horizontal ray already
hits an obstacle first. After the fix the two agree exactly at four probe heights:

| position | sensor | clearance model |
| --- | --- | --- |
| living room y = 0.3 m | 2.20 m | 2.20 m |
| living room y = 1.2 m | 1.30 m | 1.30 m |
| living room y = 2.0 m | 0.50 m | 0.50 m |
| attic y = 2.9 m | 0.60 m | 0.60 m |

#### "Started inside a wall" now has its own answer

A ray whose origin is already in non-air returned distance: 0 with ace: 'y' � the
initial value, not a real face. That is indistinguishable from "the surface is right here",
and a sensor that reports 0 m to everything is a bug that survives, because every downstream
number still looks finite. ace gained an 'origin' member for exactly this case.

#### The raster's two layers have very different standing

| layer | volumetric? | why |
| --- | --- | --- |
| **geometry** | **yes** | altitude and range come from a 3-D raycast against real voxels. The ground bot cannot produce this at all: no pose above 0.2 m, and its grid has no height |
| **thermal** | **no** | the scalar fields are ground-plane projections that ignore y (�11.28). A thermal reading carries no height information at all |

So the raster is a *height-annotated* record of where the bot looked, and summariseRaster
carries 	hermalLayerIsVolumetric: false as a typed literal � it cannot be flipped without
a type error, and it reaches the report rather than living only in a docblock.

#### The gate, and the calibration that makes it mean something

asterConfidence = coveredFraction x meanCellConfidence, and the multiplication is the
point: averaging would let three perfect cells out of 576 report 1.0.

| raster | confidence | passes 0.6? |
| --- | --- | --- |
| empty | **0.000** | no � and 0, not a vacuous pass |
| full, two consistent passes | 1.000 | yes |
| **full, one pass only** | **0.578** | **no** |
| 3 perfect cells of 576 | 0.002 | no |
| half covered, perfect | 0.500 | no |
| full, 8 K disagreement | **0.000** | no |

The 0.578 is the calibration that matters: **one pass over a ceiling is a glimpse and does
not pass**, which is the same equiredObservation = 2 the 2-D coverage metric uses and the
same reason the project previously had to reject "every wall at zero surface observations".

Disagreement scoring 0 rather than averaging to the midpoint is �5.5's principle applied:
disagreement is not averaged away, it is measured.

#### The uncomfortable result: the gate passes with nothing found

A perfectly rastered, perfectly consistent ceiling with **every deviation at 0.0 K** scores
1.000 and passes the gate. That is not a bug � confidence here is about *survey coverage and
agreement*, not about finding defects.

So the stage F gate "ceiling rasters at =0.6 confidence" **cannot be read as "the hover bot
finds things the ground bot misses"**. It is a statement about the bot having been there and
measured consistently. Those are different claims, and only the second is the one the thesis
needs � and �11.28 already measured that the volumetric manifold currently contributes
**no detection the ground manifold lacks**, because the one sensor-eligible volumetric defect
leaks downward.

The honest reading of the gate, once both halves are in: **it is met, and it is a weaker claim
than it looks.** What would make it the claim the thesis needs is volumetric-only *content* �
a defect visible from height and not from the floor � which �11.28 measured as absent, and
whose absence is now the binding constraint on the whole thesis rather than a content gap.
---

### 11.32 Closing out Stage F, and two latent coordinator bugs that only a third agent could find

Closing the stage meant wiring the hover bot into the run loop, which is where the stage
stopped being closable.

#### Gate assessment: one clause met, one met-as-modelled, and the stage is blocked on a fourth thing

| gate clause | status |
| --- | --- |
| "ceiling rasters at =0.6 confidence" | **met as a model, not demonstrated in a run.** A full two-pass sweep scores 1.000; a single pass scores 0.578 and correctly fails. In a live run the raster reads **0.0008** � one cell of 1232 � because the bot has nowhere to fly |
| "hover endurance respected by allocation" | **met**, by the capability filter rather than by the ranking (�11.30). ground.drive is absent, so the hover bot is never awarded ground work: measured **0 of 961** |

So F is not complete. It is **blocked on volumetric job announcement** � there is no
scan_ceiling job, so the hover bot holds station at its spawn for the whole mission,
spends 10.19 Wh of its 22 Wh, and rasters one cell. That is the correct behaviour for an
agent with no work, and it is not a demonstration of the gate.

#### What the wiring did produce: energy accounting that matches the model

Over a 300 s mission the hover bot spends **10.186 Wh of 22 Wh (46.3%)**, finishing at 54%
battery. The model predicts 120.6 W � 98 W x 1.23, the clearance multiplier at 1.2 m in a
2.50 m room � giving 10.05 Wh. **Measured 10.186 against a predicted 10.05**, so the power
model in hover.ts and the power model in the run loop are the same model, not two that
agree by accident.

#### Two coordinator bugs, both latent until a volumetric agent existed

**1. The sensing pass cast a Pose3 to Pose2.** if (isLumenPose(agent.pose)) continue
skipped the crawler and nothing else. A hover bot fell through to gent.pose as Pose2, so
p.theta was undefined. That does not throw � it produces NaN bearings, and the thermal
detector then emits a candidate per ray:

| swarm | mission | jobs | candidates | wall clock |
| --- | --- | --- | --- | --- |
| ground only | 4 s | 5 | 4 | 525 ms |
| **hover only** | **4 s** | **1920** | **1920** | **415 s** |
| hover only, fixed | 300 s | **0** | **0** | **707 ms** |

**2. The coverage announce picked a volumetric agent to anchor ground jobs.** The guard was
.spec.cls !== 'inchworm', correct while every non-crawler was a ground bot. It selected the
hover bot, read x and z off a Pose3 � which works *by accident*, because Pose3 has
both fields � and anchored 480 ground frontier jobs per second of mission at a bot that can
never service one.

Both were correct code for the world as it stood, and both were **wrong the moment a third
manifold existed**. That is the strongest argument so far in this project for keeping the
manifold-typed dispatch explicit: the alternative is a cast that is right until the day it
is not.

The fix for the second is the same shape as the market's rule: **do not announce work on a
manifold no agent in the swarm can service.** Coverage budgeting now counts only ground
agents, so a crawler-only swarm announces conduit work and nothing else, and a volumetric
swarm announces ceiling work and nothing else.

Parity held at 8f9dfce8 through both, which is the check that the fix did not disturb the
ground path � every ground bot is on the ground manifold, so the guard is a no-op there.
425 tests green.