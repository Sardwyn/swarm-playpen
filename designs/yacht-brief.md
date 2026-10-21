# One survey, done twice

*A proposal to a marine engineer, a surveyor, or an owner. Three minutes to read.*

---

## What we have built

A simulator that runs a small swarm of inspection robots on a boat and produces the
report a surveyor would produce if they could go everywhere: what was examined,
what was found, **what was not examined, and why**.

We have run it on a midships section of a Sunseeker Predator 55. The engine room's
sole is covered **100%** — every square metre of it examined at least twice —
while the void above it never is. Seven faults were put in the model. Four were
found. Three were missed, and the three misses have three different causes, which
is the part we care about:

| | what happened | whose fault |
|---|---|---|
| **A condensation in the forward stringer void** | The void is sealed at both ends and entered from nowhere except two 200 mm holes in the deck. The ground robot is 340 mm across. The hover robot is 240 mm across and needs a metre of ceiling. The crawler lives in conduits, and the void has none. **The swarm never got within 6.4 m.** | the boat's architecture |
| **A salt equilibrium in the deckhead void** | The deckhead void over the engine is 410 mm tall. The hover robot needs 1.0 m. It went in, held station against the ceiling for its whole 12 Wh pack, and faulted on empty. | our endurance model |
| **A blocked engine-bay extraction inlet** | The robot was 0.69 m away. The detector did not fire: the air proxy at the port rises 118% over ambient and the gate is a 150% rise, so the whole field peaks below the threshold. | our calibration |

Only the first is the product. The other two are bugs, and we now know where they
are.

## The finding we want to test on a real boat

**A 200 mm opening is a hand-hole. Nobody gets their body through one — but a
person can kneel on the deck, put an arm and a torch through it, and feel around
for damp.** That is what a surveyor does with a void.

So the benchmark is not "can a robot go where a person goes". It is:

> **Can the instrument do something a person's arm and a light can do?**

Our swarm cannot. It cannot get its sensor within 340 mm of the hole. If that
holds on a real boat, then there is a class of finding that nobody can produce
from the deck — and the only way to produce it is to leave something in the void.

## What we are asking for

**One survey, done twice.** We would like to run the conventional survey on a boat
you are surveying anyway — moisture meter, borescope, the works — and then leave a
logger in the void for two weeks.

You get:

- the survey, with the inaccessible spaces covered and **stated as covered rather
  than assumed clean**;
- a comparison of what a hand and a torch found against what a sensor found;
- the raw readings, and the reasoning behind every conclusion, including the ones
  we got wrong.

We get:

- the real fault taxonomy for this class of boat;
- the real access geometry, which is currently the single number our whole result
  turns on;
- the first evidence that a coverage statement changes a conclusion.

**Cost to you:** the time you would spend on the void checks anyway, plus two
weeks of leaving a £40 logger in a void. **No fee.** We are trying to find out
whether this is a product, and the cheapest way to find out is to run it once
properly.

## What we cannot do, and are not going to pretend we can

- **Corrosion at dissimilar metals needs eyes.** We cannot see it and we will not
  claim to. It is in our taxonomy with no instrument attached, deliberately.
- **One humidity reading cannot tell you the cause.** A leak, a condensation and
  historic salt in the core all read the same. Separating them needs a *time
  series* and a wash cycle — which is why our product is a deployment and not a
  handheld meter, and why the report says "a moisture anomaly of undetermined
  cause" rather than guessing.
- **Our geometry is assumed.** The published principal characteristics are
  Sunseeker's; every profile, bulkhead, deck height, hatch size and pipe route in
  the model is a placeholder. That is why the survey is worth doing.

## The one question we cannot answer ourselves

**On this class of boat, how big is the access hatch into a hull void?**

If you have ever had a stringer void opened — what was cut, how wide was it, and
would you put your arm in and feel round, or would you get in? A number is worth
more than a story, and "it varies" is worth a lot too: it would mean the class
splits into two products.

---

### The fault taxonomy we are working from

*What the instrument produces, and what it cannot.*

| reading | the causes it is consistent with | separable? |
|---|---|---|
| humidity above baseline | active water ingress · condensation in a void · historic salt in the core · deck penetration leak · bilge high | **no** — needs a time series |
| temperature deviation | exhaust leak · overheating bearing · hot electrical connection | no — needs a load correlation |
| an obstructed passage | blocked ventilation · blocked drainage · debris in a fuel line | no — needs the manifold |
| an obstruction on the map | blocked drainage · debris in the bilge | no — needs eyes |
| a surface discontinuity | weld defect · hull stress crack | no — needs ultrasonic |

*And what no instrument in this class will ever see:* corrosion at dissimilar
metals, an unrecorded modification, and — today — machinery vibration, which is a
detector gap rather than a sensor gap.

---

**Contact:** [your details]
**Full domain document:** `designs/yacht-inspection-domain.md`
**What the swarm actually did, and the measurements:** `npm run diag:yacht-sim`
