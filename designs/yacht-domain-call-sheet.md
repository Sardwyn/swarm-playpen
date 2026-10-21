# Marine engineer call sheet — yacht domain

**Counterpart:** Otto Mukahanana
**Purpose:** decide whether a void-state measurement product has a first buyer on a
Sunseeker MY, and whether the measurable voids are reachable at all.
**Duration:** 60 min (30-min cut list in §9)
**Domain spec:** `designs/yacht-inspection-domain.md` — read §4 and §11 before the call

---

## 0. The decision this call makes

Three outcomes, and it is fine if it is the third one:

| Outcome | Condition | Then |
|---|---|---|
| **GO** | Voids reachable **and** the pain is felt **and** he'd use the thing | Build the void logger. §10 |
| **PIVOT** | Voids reachable but no pain; **or** not reachable but the coverage report is wanted | Different product, still viable. World B in spec §4 |
| **STOP** | No felt pain, no reachable voids, no appetite | The yacht domain is dead. Take the method to commercial fleet, or to the agent domain |

**The purpose of the call is to find out which one, not to get a yes.** A yes in
hour one that turns into silence in hour three has cost you a month.

---

## 1. Ground rules

**Do:**
- Ask about the boat, not about the tool
- Ask for stories, not opinions — *"walk me through the last one you did"*
- Write down his words, not your paraphrase of them
- Let him say the domain is fine as it is

**Do not:**
- Mention AI
- Mention a robot (not yet — it is a Stage 3 thing, and mentioning it early makes
  you sound like a vendor)
- Pitch, describe your design, or show the spec
- Use the words "revolutionary", "AI", "platform", "solution"
- Lead with the idea. **Ask about the access problem first, then the failures, and
  only float the idea in §F.**

**Why:** if he hears a pitch he will either dismiss it or over-promise. If he hears a
hard question about his own work, he will give you his actual knowledge. The second
one is what you are here for.

---

## 2. Bring and set up

| | |
|---|---|
| **Print** | The Sunseeker construction spec for the model in question (materials, stringers, bulkheads, access hatches). Use it to point, never to present |
| **Bring** | A blank sheet — this document, printed, with the note lines |
| **Bring** | An RH + temperature logger, ~£40. **Optional but the single most persuasive thing you can own.** If you can put one in a void on a boat for a week, show him the curve. A curve beats a description |
| **Have ready** | The instrument names you have found in the research: capacitance meter (Tramex / Sovereign), IR, UT gauge, borescope |

---

## 3. Frame (3 min)

> "I've been looking at how condition is actually assessed on these boats. I'm trying
> to work out whether there's a measurement problem that's real but not being
> measured, or whether I'm imagining one. You know these boats far better than I do.
> I'd rather you tell me I'm wrong."

**What you're doing:** establishing that you want correction, not agreement. It also
sets the expectation that you'll go away and think about it.

**Listen for:** whether he engages with the *measurement* question or steers to
"just look at it properly". Both are useful. The first is a friend; the second is
usually someone who has a process they trust.

---

## 4. A — Access reality (12 min) · *the kill switch*

### A1. Which spaces do you actually get into on one of these?
> "On a 50-footer — engine room, lazarette, cockpit sole, cabins. Which of those do
> you open, and which do you never bother with?"

🎯 **Good:** specific spaces, and a reason for each skip.
⚠️ **Bad:** "you can't really get into those" — note it and keep going; it is World C.

📝
>
>
→ So what:

---

### A2. Have you ever had a stringer void opened?
> "Have you ever had one of the hull voids — between the stringers — opened up? Which
> ones, and how was the access made? Yard hatch, or did somebody cut the GRP?"

🎯 **Good:** a specific job he can describe — what was cut, what was inside, how long
it took, whether it was found to be dry or wet.
📝
>
>
→ So what:

**And the follow-up, which is the one the whole product turns on:** *how big was the
opening?* Not "could you get in" — **how wide was the hole**, and could a person's
arm and a torch go through it?

Because 200 mm is a hand-hole, not a man-way. Nobody gets their body through one.
A surveyor kneels on the deck, puts an arm and a torch in, and feels around. That
is the practice, and the practice is the benchmark: **the instrument has to be able
to do something a person's arm can do, or it is not worth carrying.**

Ask it as: *"When you open one of those, what's the smallest hole you'd call an
access? And would you put your arm in and feel round, or would you get in?"*

🎯 **Good:** a number. "150 by 150" or "200 by 300" or "you'd cut it bigger".
⚠️ **Bad:** "it varies" — then ask which of his own boats.

---

### A3. What's inside a stringer void?
> "Give me one. What's actually in there — wiring, conduit, foam, old tank baffles,
> bilge water? How deep is it?"

🎯 **Good:** contents, and — crucially — **whether it was wet, damp or dry.** If he's
opened voids and they were dry, that's important and cuts against you.
📝
>
>
→ So what:

---

### A4. The blind spot question · *the most important one in the call*
> "How do you actually check the balsa core in the topsides of one of these? You can't
> get in behind it, so you're reading through the skin. And when the meter reads high —
> what do you do next?"

🎯 **Good:** the current method, and the escalation. *"We drill a small hole and
check whether water comes out"* / *"we go round again in a month and see if it's
changed"* / *"we call a yard for a quote"*.
⚠️ **Bad:** "you don't really, the topsides are fine." Means no felt pain here.

📝
>
>
→ So what:

---

### A5. Which spaces never get inspected, by anyone, ever?
> "What's on these boats that nobody ever looks at?"

📝
>
>
→ So what:

---

### A6. Deckhead void
> "Is there any access into the space between the deckhead liner and the deck above?"

📝
>
>
→ So what:

---

## 5. B — What actually fails (12 min)

### B1. Top five, by cost
> "What breaks on these boats? Give me the top five by what it costs the owner, and
> where each one lives."

📝 | Fault | Where | Cost | Found how | Found when |
>---|---|---|---|---|---|
> | 1. | | | | |
> | 2. | | | | |
> | 3. | | | | |
> | 4. | | | | |
> | 5. | | | | |

---

### B2. Routine vs. reactive
> "Which of those do you find on a routine service, and which do you only find after
> something's already gone wrong?"

🎯 **Good:** splits the list into two, and the reactive half is your opportunity.

---

### B3. The one you never find early
> "Is there a failure you always find, and always find too late?"

📝
>
>
→ So what:

---

### B4. The undiagnosable complaint
> "What do owners complain about that you can't pin down?"

📝
>
>
→ So what:

---

### B5. What you tell owners to watch for
> "When you hand over, what do you tell the owner to keep an eye on?"

📝
>
>
→ So what:

---

## 6. C — Current practice (10 min)

### C1. The kit
> "What do you actually carry? Make and model of the moisture meter?"

📝 Meter: ______  Scale: ______  Other:

🎯 **Note:** whether he says the make and scale *without being asked*. The published
critique is that reports frequently don't.

---

### C2. The report
> "Do you write the meter and the scale into the report? Do you write down a baseline?"

📝
>
>
→ So what:

---

### C3. The grid
> "How many readings on a typical hull survey, and on what spacing?"

📝 Grid spacing: ______  Total readings: ______  Above WL: ______  Below WL: ______

---

### C4. Where the time goes
> "Take me through the survey. Where does the time actually go?"

🎯 **Good:** tells you what is expensive to do — which is what a new method has to
beat.

---

### C5. The safety question · *this is the robot's justification*
> "Do you ever go into the engine space? What if there's fuel vapour in there — how do
> you decide whether it's safe to go in?"

🎯 **Good:** a real procedure, and a real limit. If there's a limit, note it exactly.
⚠️ **If he says he wouldn't go in — write that sentence down verbatim.** It is the
sentence that justifies remote inspection.

📝
>
>
→ So what:

---

### C6. The artefact
> "Can I see a survey report you've written? I'll strip the client's name off it."

📝 **Got it: Y / N**

---

## 7. D — Economics (8 min)

### D1
> "What does a pre-purchase survey cost, and who pays for it — the buyer, the broker,
> the seller?"

📝 Cost: ______  Payer: ______

---

### D2 · *the value of a finding*
> "When a survey finds something, what does that do to the price?"

📝
>
>
→ So what:

---

### D3 · *the liability exposure that a coverage statement addresses*
> "Have you ever been called back because a survey missed something? What happened?"

🎯 **Good:** a specific story. This is the reason a report that states its coverage
is worth something: it changes who carries the risk.

📝
>
>
→ So what:

---

### D4
> "How often do buyers skip the survey altogether? Why?"

📝
>
>
→ So what:

---

## 8. E — Access and modification (7 min)

### E1 · *do not cut holes*
> "Who can cut a GRP hull? What's the process, what does it cost, and does it affect
> the warranty or the resale?"

📝
>
>
→ So what:

---

### E2
> "What do owners modify? And what breaks afterwards?"

📝
>
>
→ So what:

---

### E3
> "Where does water get in that nobody expected?"

📝
>
>
→ So what:

---

## 9. F — The business case (8 min)

### F1
> "Last thing. Suppose there was a way to tell you which of the voids on a boat were
> wet before you opened them. Would you use it — and what would it be worth?"

📝 Would use it: Y / N  Why: ______________________  Worth: ______

---

### F2
> "Who else would use it? Captains? Managers? Brokers? Insurers? The yard?"

📝
>
>
→ So what:

---

### F3 · *the smallest thing that would sell*
> "What's the smallest version of this you'd actually pay for?"

📝
>
>
→ So what:

---

### F4 · *make him attack it*
> "Last question, and I want the hostile version. Why would a surveyor use this
> instead of what they already do?"

🎯 **Good:** real objections. **His objections are the v2 specification.**
⚠️ **Bad:** "no reason, it's a great idea." That is a bad sign, not a good one.

📝
>
>
→ So what:

---

## 10. G — The ask (5 min)

Only if the call has landed. Ask it last and keep it small.

> "One thing I'd like to try. Put a small humidity and temperature logger in a couple
> of voids on one of your boats — yours, or one of a customer's you're already doing
> work on — and leave it for a season. Let it show you what a void actually does
> through a wash cycle and through the summer."

📝 **Boat:** ______________________  **Access:** ______________________
**Voids:** ______________________  **Period:** ______________________
**Agreed:** Y / N

**Why this is the ask and not something bigger:** a logger costs £40, breaks nothing,
and needs no decision from him. If he says yes you have a real dataset, a real
boat, and a real relationship — and the dataset *is* the product's first evidence.
If he says no, you have learned that without spending anything.

**Also ask, low pressure:**
> "Who else should I be talking to? A surveyor? A broker? A captain?"

📝 Names to approach:

---

## 11. Artefact checklist

Ask for these across the call, not as a bundle at the end.

| | Ask | Got | Note |
|---|---|---|---|
| ☐ | A survey report, anonymised | | |
| ☐ | Photo of the instrument kit / meter model | | |
| ☐ | Photos of the engine bay sole open | | |
| ☐ | Photos or notes of any void ever opened | | |
| ☐ | An owner's maintenance log | | |
| ☐ | Boatyard as-built drawing, if one exists | | *Often differs from the brochure.* |
| ☐ | One hull inspection photo set | | |
| ☐ | Yard contact for GRP cutting | | From E1 |

---

## 12. Decision record — fill in during the call

| Question | Answer | Effect on the plan |
|---|---|---|
| A2 — voids ever opened? | | World A / B / C |
| A3 — were they wet? | | Whether the product measures anything real |
| A4 — how is balsa core checked? | | Whether there is felt pain |
| B3 — never found early? | | Whether prevention is the wedge |
| C5 — would you go in with vapour? | | Whether remote inspection is required |
| D3 — called back for a miss? | | Whether coverage statements carry value |
| F1 — would you use it? | | Whether there is a buyer |
| F4 — why would anyone use it? | | The whole product, or a rewrite |
| G — the boat | | Whether the MVP can be built |

**Overall:** GO / PIVOT / STOP

---

## 13. After the call

1. **Transcribe his words before you interpret them.** Write what he said in the note
   lines first; the interpretation goes in a separate column, because you will be
   wrong about at least one of them.
2. **Rewrite the §5 table (F1–F15) from B1–B5.** His failures replace my invented
   ones. Keep the observability columns; fill them from A4, C5 and the rest.
3. **Update spec §4 (access) with the World answer.**
4. **If GO:** build the logger. £40 of parts, an afternoon, and the report layer you
   already have.
5. **If PIVOT:** the coverage report is the product, and World B's indirect
   measurement is the method. Update spec §10.3.
6. **If STOP:** write down *why* it failed, in one paragraph, and put it in the next
   domain. This is the same discipline as the swarm's own kill conditions: the
   decision gets recorded and it is not revisited without new evidence.

---

## 14. Questions I did not ask, and why

| Not asked | Why |
|---|---|
| About software, AI, robotics | Would have changed how he answers A–F |
| "Would you like to see what we've built?" | Ask in G, after he has described his own work |
| "Would you invest?" | Too early, too big, and it invites a yes that means nothing |
| "What do you think of the idea?" | He has not got the idea yet, and asking invites polite agreement |
| Whether he knows other boats in the range | Ask at the end of G, after he's relaxed |
