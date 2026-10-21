/**
 * The yacht content, loaded.
 *
 * ## Why this module exists
 *
 * The browser cannot read a file, so the content has to come in as an import. The
 * house does exactly this in `world/content.ts`. Putting the yacht's load in one
 * place means the diagnostic and the scene read the same bytes through the same
 * path, which is the only way the two can be trusted to agree.
 *
 * A diagnostic that reads the file and a scene that imports it can drift, and the
 * drift is invisible until somebody puts the two pictures side by side.
 */

import yachtJson from '../../content/yacht-01.json'
import { loadYacht01 } from './yacht.ts'
import type { RawContent } from './yacht.ts'

export const yacht = loadYacht01(yachtJson as unknown as RawContent)
