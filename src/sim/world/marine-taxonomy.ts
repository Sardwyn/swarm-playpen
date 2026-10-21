/**
 * The marine fault taxonomy. Domain artifact — the twin's answer to "what does
 * a surveyor actually look for on a boat".
 *
 * ## The distinction the whole file turns on
 *
 * A **signature** is a physical reading an instrument can produce: "relative
 * humidity above my own baseline, sustained", "surface temperature deviating
 * from a baseline I estimated", "a passage is obstructed".
 *
 * A **class** is a *cause*: the thing that would be written on a surveyor's
 * report. "Condensation in the void." "Active water ingress." "Blocked drainage."
 *
 * The swarm produces signatures. A person produces causes. The taxonomy is the
 * map between them, and it deliberately does **not** claim the map is one-to-one:
 * five causes share the `moisture_leak` signature, and the file says so in the
 * place where a reader would otherwise assume otherwise.
 *
 * That is not a hedge. It is the finding. An instrument that reports "active
 * water ingress" from a humidity reading is guessing, and a marine surveyor
 * would spot the guess in under a minute. An instrument that reports "a moisture
 * anomaly of undetermined cause, here, at this date" is telling the truth, and
 * the truth is worth more because the owner knows what to do next: deploy it
 * longer and watch.
 *
 * ## Genericity
 *
 * This module is domain code. The engine does not know about signatures or
 * causes; it matches candidates to truth entries by the truth entry's declared
 * **signature**, which is the generic vocabulary. The taxonomy lives here, with
 * the domain, and the twin's content file references it.
 */

import raw from '../../content/marine-taxonomy-01.json'

/** The generic vocabulary a candidate can be matched on. */
export const MARINE_SIGNATURE_IDS = [
  'moisture_leak',
  'thermal_anomaly',
  'structural_crack',
  'blocked_vent',
  'clutter_hazard',
  'pest_indicator',
] as const

export type MarineSignatureId = (typeof MARINE_SIGNATURE_IDS)[number]

/**
 * How well the current instrument suite can see a class.
 *
 * `not_observable` is not a shrug. It is the product's boundary, written down.
 */
export type Observability = 'measurable' | 'indirect' | 'not_observable'

export type MarineSignature = {
  readonly id: MarineSignatureId
  /** What the instrument physically measures. */
  readonly reading: string
  /** The instrument that produces it. */
  readonly instrument: string
  /** The causes this reading is consistent with. */
  readonly causes: readonly string[]
  /** False when the reading cannot be attributed to one cause. */
  readonly separable: boolean
  /** What it would take to resolve the cause. */
  readonly resolutionRequires: string
  readonly note: string
}

export type MarineClass = {
  readonly id: string
  /** The row in the domain spec this class came from. */
  readonly docRef: string
  readonly name: string
  readonly spaces: readonly string[]
  /**
   * Every reading that can indicate this class.
   *
   * Most classes list one. `blocked_drainage` lists two, because a blocked drain
   * presents as an obstructed passage *or* as an obstruction on the map depending
   * on where you look at it. A class the instrument cannot produce at all lists
   * none.
   */
  readonly signatures: readonly MarineSignatureId[]
  readonly observable: Observability
  readonly secondObservable: string
  readonly corroborable: boolean
  readonly corroborationMethod: string
  /** What the owner or the yard does about it. */
  readonly remedy: string
  /** 0..1. */
  readonly severityWeight: number
  readonly note: string
}

export type MarineTaxonomy = {
  readonly id: string
  readonly domain: string
  readonly signatures: readonly MarineSignature[]
  readonly classes: readonly MarineClass[]
}

function validate(rawTaxonomy: unknown): MarineTaxonomy {
  if (typeof rawTaxonomy !== 'object' || rawTaxonomy === null) {
    throw new Error('marine taxonomy: expected an object')
  }
  const t = rawTaxonomy as Record<string, unknown>

  if (!Array.isArray(t.signatures)) throw new Error('marine taxonomy: `signatures` must be an array')
  if (!Array.isArray(t.classes)) throw new Error('marine taxonomy: `classes` must be an array')

  const signatureIds = new Set<string>()
  const signatures: MarineSignature[] = t.signatures.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`marine taxonomy: signatures[${i}] expected an object`)
    }
    const s = entry as Record<string, unknown>
    const id = s.id as string
    if (!MARINE_SIGNATURE_IDS.includes(id as MarineSignatureId)) {
      throw new Error(
        `marine taxonomy: signature '${id}' is not in the generic vocabulary — ` +
          `a detector cannot produce a signature the engine does not know`,
      )
    }
    if (signatureIds.has(id)) throw new Error(`marine taxonomy: duplicate signature '${id}'`)
    signatureIds.add(id)
    if (!Array.isArray(s.causes)) throw new Error(`marine taxonomy: signature '${id}' needs causes`)
    return {
      id: id as MarineSignatureId,
      reading: (s.reading as string) ?? '',
      instrument: (s.instrument as string) ?? '',
      causes: s.causes as string[],
      separable: s.separable === true,
      resolutionRequires: (s.resolutionRequires as string) ?? '',
      note: (s.note as string) ?? '',
    }
  })

  const classIds = new Set<string>()
  const classes: MarineClass[] = t.classes.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`marine taxonomy: classes[${i}] expected an object`)
    }
    const c = entry as Record<string, unknown>
    const id = c.id as string
    if (typeof id !== 'string' || id.length === 0) throw new Error(`marine taxonomy: classes[${i}] needs an id`)
    if (classIds.has(id)) throw new Error(`marine taxonomy: duplicate class '${id}'`)
    classIds.add(id)

    const rawSignatures = c.signatures
    if (!Array.isArray(rawSignatures)) {
      throw new Error(`marine taxonomy: class '${id}' needs a signatures array`)
    }
    const classSignatures = (rawSignatures as string[]).map((sig) => {
      if (!signatureIds.has(sig)) {
        throw new Error(`marine taxonomy: class '${id}' names signature '${sig}', which is not declared`)
      }
      return sig as MarineSignatureId
    })

    const observable = c.observable as Observability
    if (!['measurable', 'indirect', 'not_observable'].includes(observable)) {
      throw new Error(`marine taxonomy: class '${id}' has an unknown observability '${String(c.observable)}'`)
    }

    // A class that no instrument can produce must not claim a signature. This is
    // the check that keeps the "what we cannot see" list honest: if somebody
    // later gives `corrosion_dissimilar_metals` a signature, they have to mean it.
    if (observable === 'not_observable' && classSignatures.length > 0) {
      throw new Error(
        `marine taxonomy: class '${id}' is marked not_observable but names a signature — ` +
          `either the instrument can see it or it is on the boundary`,
      )
    }
    if (observable !== 'not_observable' && classSignatures.length === 0) {
      throw new Error(
        `marine taxonomy: class '${id}' is claimed observable but names no reading — ` +
          `there would be nothing for the instrument to produce`,
      )
    }

    const severityWeight = c.severityWeight as number
    if (!(severityWeight > 0 && severityWeight <= 1)) {
      throw new Error(`marine taxonomy: class '${id}' needs a severityWeight in (0, 1]`)
    }

    return {
      id,
      docRef: (c.docRef as string) ?? '',
      name: (c.name as string) ?? id,
      spaces: Array.isArray(c.spaces) ? (c.spaces as string[]) : [],
      signatures: classSignatures,
      observable,
      secondObservable: (c.secondObservable as string) ?? '',
      corroborable: c.corroborable === true,
      corroborationMethod: (c.corroborationMethod as string) ?? '',
      remedy: (c.remedy as string) ?? '',
      severityWeight,
      note: (c.note as string) ?? '',
    }
  })

  // Every cause a signature lists must be a declared class, or the taxonomy is
  // pointing at something that does not exist.
  for (const s of signatures) {
    for (const cause of s.causes) {
      if (!classIds.has(cause)) {
        throw new Error(`marine taxonomy: signature '${s.id}' lists cause '${cause}', which is not a declared class`)
      }
    }
  }
  // And every class with a signature must be listed under it, or the map is
  // incomplete in the direction that hides classes. The check runs both ways:
  // a class that claims a reading the signature does not know about is as wrong
  // as a signature that lists a cause that does not claim it.
  for (const c of classes) {
    for (const sigId of c.signatures) {
      const sig = signatures.find((s) => s.id === sigId)
      if (sig === undefined) continue
      if (!sig.causes.includes(c.id)) {
        throw new Error(
          `marine taxonomy: class '${c.id}' has signature '${sigId}' but is not listed among its causes`,
        )
      }
    }
  }
  for (const s of signatures) {
    for (const causeId of s.causes) {
      const cls = classes.find((c) => c.id === causeId)
      if (cls === undefined) continue
      if (!cls.signatures.includes(s.id)) {
        throw new Error(
          `marine taxonomy: signature '${s.id}' lists cause '${causeId}', which does not claim that signature`,
        )
      }
    }
  }

  return {
    id: (t.id as string) ?? 'marine-taxonomy',
    domain: (t.domain as string) ?? '',
    signatures,
    classes,
  }
}

export function loadMarineTaxonomy(rawTaxonomy: unknown = raw): MarineTaxonomy {
  return validate(rawTaxonomy)
}

export function classById(taxonomy: MarineTaxonomy, id: string): MarineClass | undefined {
  return taxonomy.classes.find((c) => c.id === id)
}

export function signatureById(taxonomy: MarineTaxonomy, id: string): MarineSignature | undefined {
  return taxonomy.signatures.find((s) => s.id === id)
}

/**
 * The causes a given signature is consistent with — the honest answer to "what
 * could this reading be".
 */
export function causesOf(taxonomy: MarineTaxonomy, signatureId: string): readonly MarineClass[] {
  return taxonomy.classes.filter((c) => c.signatures.includes(signatureId as MarineSignatureId))
}
