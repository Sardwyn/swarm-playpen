/**
 * The yacht domain, loaded for the simulation.
 *
 * ## Why this exists
 *
 * The house's content and anomalies are imported at module scope in
 * `world/content.ts` and `world/anomalies.ts`, which is fine for one domain and
 * fatal for two. `loadHouse` and `loadAnomalySet` were already generic — they
 * take a raw object and validate it — so the only thing that had to change in the
 * engine was one optional parameter on `createRun`.
 *
 * **That is the whole genericisation, and it is one line.** The engine did not
 * learn about boats. It learned that the oracle is an input.
 *
 * ## What the two manifolds mean on a boat
 *
 * The sim has one ground plane, one set of conduits, and one volume above the
 * ground plane. On a midships section of a motor yacht those become:
 *
 * - **ground** — the engine room sole
 * - **constrained** — the engine room's pipe runs
 * - **volumetric** — the space above the engine room sole: the deckhead void over
 *   the engine, the cockpit airspace, and the forward stringer void
 *
 * The stringer void is the largest volume on the boat, and it is entered only
 * through two 200 mm deck hatches. The ground bot is 340 mm across, the hover bot
 * needs 400 mm of clearance, and the inchworm is confined to conduits. So the
 * swarm cannot get in, and the most severe fault on the vessel is in there.
 *
 * None of that is authored. It is what the geometry does.
 */

import { loadHouse } from './content.ts'
import { loadAnomalySet } from './anomalies.ts'
import { buildHullForm } from './yacht-form.ts'
import type { HullForm, Principal } from './yacht-form.ts'
import yachtJson from '../../content/yacht-sim-01.json'
import yachtAnomalies from '../../content/yacht-sim-anomalies-01.json'

/** The vessel, in the schema the engine already speaks. */
export const yachtHouse = loadHouse(yachtJson as unknown)

/** The oracle for the vessel. */
export const yachtTruth = loadAnomalySet(yachtAnomalies as unknown)

/**
 * The published principal characteristics.
 *
 * `loadHouse` does not keep them — the engine has no use for a boat's length — so
 * they are read straight off the content file for the renderer and the panel.
 */
export const yachtPrincipal = (
  yachtJson as unknown as { principal: Principal }
).principal

/**
 * The hull's shape, derived from the same content file the simulator read.
 *
 * The form is a *rendering* concern — the simulation needs the occupancy grid, not
 * a waterline — so it is computed here from the published profiles and handed to
 * the viewer, which is the same arrangement as the crawler's pose being projected
 * at the frame boundary.
 */
export const yachtForm: HullForm = buildHullForm(
  yachtPrincipal,
  (yachtJson as unknown as { profiles: Parameters<typeof buildHullForm>[1] }).profiles,
)

/** The assumptions the whole vessel rests on. Printed in the panel. */
export const yachtAssumptions: readonly string[] =
  (yachtJson as unknown as { _assumptions?: string[] })._assumptions ?? []

/** Where the ground bot starts: the engine room sole, forward of the machinery. */
export const YACHT_SPAWN = { x: -3.4, z: 0.0, theta: 0.0 }

/**
 * The port the inchworm lives at.
 *
 * The house's default is `duct-drop-utility`, which does not exist here. The
 * constrained manifold is not connected — the three pipe runs are separate
 * components — so a scenario has to choose which one it is studying, and the
 * fuel line is the one with the fault in it.
 */
export const YACHT_INCHWORM_HOME = 'port-fuel-a'
