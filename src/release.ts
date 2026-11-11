import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolPolicy } from './shared'
import type { ActivationHistory, ReleasedBaseline, ReleasedEntry, ReleaseReceipt, SessionAccount, ToolCatalogItem } from './types'
import { z } from 'zod'
import { ACTIVATOR_SOURCE_KIND, CATALOG_FORM, LOCKED_TOOL_NAMES, RELEASE_REASON_KINDS } from './constants'

/**
 * What the session activated and has not released.
 *
 * The release baseline is subtracted here, so the idle policy and the release
 * decision read one account and cannot drift apart.
 */
export function activeAccount(history: ActivationHistory, released?: ReleasedBaseline): { identifiers: string[], names: string[] } {
  return {
    identifiers: history.activatedToolIds.filter(id => !released?.identifiers.has(id)),
    names: (history.activatedToolNames ?? []).filter(name => !released?.names.has(name)),
  }
}

/**
 * Whether a tool name may leave the session's enabled set.
 *
 * The basic tools are the user's standing decision and the locked tools manage
 * the catalog itself; neither of them is ever released.
 */
export function isReleasableName(name: string, policy: ToolPolicy): boolean {
  return !policy.basicTools.includes(name) && !LOCKED_TOOL_NAMES.includes(name)
}

/** The facts one release decision is read from: the account without its clock. */
export type ReleaseFacts = Omit<SessionAccount, 'clock'>

/** One entry a release took out of the session's enabled set. */
export interface ReleaseEntryPlan {
  identifier: string
  names: string[]
}

/** What one release call would do, before it does it. */
export interface ReleasePlan {
  released: ReleaseEntryPlan[]
  refused: Array<{ identifier: string, reason: string }>
  notFound: string[]
  alreadyReleased: string[]
}

/**
 * Decide what a release of the given identifiers does.
 *
 * The identifier is the unit of release: a group is released by its
 * identifier, and a bare tool name only when no activated group provides it.
 * A name an activated group provides is refused rather than silently taken out
 * of the group, because the model would then hold a group it believes is
 * complete and is not.
 *
 * The decision is a pure function of the session's account: the same account
 * answers the same way, whether the account came from the projection or from
 * the in-memory release baseline.
 */
export function planRelease(facts: ReleaseFacts, identifiers: readonly string[]): ReleasePlan {
  const basic = new Set(facts.policy.basicTools)
  const locked = new Set(LOCKED_TOOL_NAMES)
  const account = activeAccount(facts.history, facts.released)
  const activatedIds = new Set(account.identifiers)
  const activatedNames = new Set(account.names)
  const byIdentifier = new Map(facts.catalog.map(entry => [entry.identifier, entry]))
  const holders = new Map<string, ToolCatalogItem[]>()
  for (const entry of facts.catalog) {
    for (const tool of entry.tools) {
      const list = holders.get(tool.name) ?? []
      list.push(entry)
      holders.set(tool.name, list)
    }
  }

  const plan: ReleasePlan = { released: [], refused: [], notFound: [], alreadyReleased: [] }
  const seen = new Set<string>()
  for (const requested of identifiers) {
    if (seen.has(requested))
      continue
    seen.add(requested)
    // The locked tools are the ones that manage the catalog itself: they are
    // always in the model's face, and a session that could not call them would
    // be stuck with a catalog it cannot act on.
    if (locked.has(requested)) {
      plan.refused.push({ identifier: requested, reason: `Tool ${requested} is locked and always available; it cannot be released.` })
      continue
    }
    // The basic tools are the user's own standing decision; a session release
    // never touches them.
    if (basic.has(requested)) {
      plan.refused.push({ identifier: requested, reason: `Tool ${requested} is a basic tool and is always loaded; it cannot be released.` })
      continue
    }
    const entry = byIdentifier.get(requested)
    if (entry) {
      // An activated identifier carries its whole membership; an identifier
      // that is not activated only carries the names the session activated on
      // their own.
      const names = entry.tools
        .map(tool => tool.name)
        .filter(name => isReleasableName(name, facts.policy))
        .filter(name => activatedIds.has(entry.identifier) || activatedNames.has(name))
      if (names.length === 0) {
        plan.alreadyReleased.push(requested)
        continue
      }
      plan.released.push({ identifier: requested, names })
      continue
    }
    // A bare tool name: only a name no activated group provides may go on its
    // own.
    const covering = (holders.get(requested) ?? []).filter(candidate => activatedIds.has(candidate.identifier))
    if (covering.length > 0) {
      plan.refused.push({
        identifier: requested,
        reason: `Tool ${requested} is provided by the activated group ${covering[0]!.identifier}; release the group identifier ${covering[0]!.identifier} instead.`,
      })
      continue
    }
    if (activatedNames.has(requested)) {
      plan.released.push({ identifier: requested, names: [requested] })
      continue
    }
    if ((holders.get(requested) ?? []).length > 0) {
      plan.alreadyReleased.push(requested)
      continue
    }
    plan.notFound.push(requested)
  }
  return plan
}

/**
 * The receipt one release call answers with.
 *
 * A release that changed nothing is still a success when every name it named
 * was already released: a retry has to stay harmless. A call that named
 * something that could not be released is not.
 */
export function releaseReceipt(plan: ReleasePlan): ReleaseReceipt {
  const identifiers = plan.released.map(entry => entry.identifier)
  const toolNames = [...new Set(plan.released.flatMap(entry => entry.names))]
  const requested = plan.released.length + plan.refused.length + plan.notFound.length + plan.alreadyReleased.length
  const success = identifiers.length > 0 || (requested > 0 && plan.alreadyReleased.length === requested)
  return {
    success,
    released: { identifiers, toolNames },
    refused: plan.refused,
    notFound: plan.notFound,
    alreadyReleased: plan.alreadyReleased,
  }
}

export const releaseReceiptSchema = z.object({
  success: z.boolean(),
  released: z.object({
    identifiers: z.array(z.string()),
    toolNames: z.array(z.string()),
  }),
  refused: z.array(z.object({ identifier: z.string(), reason: z.string() })),
  notFound: z.array(z.string()),
  alreadyReleased: z.array(z.string()),
}) satisfies z.ZodType<ReleaseReceipt>

export const releasedEntrySchema = z.object({
  identifier: z.string(),
  names: z.array(z.string()),
  reason: z.object({
    kind: z.enum(RELEASE_REASON_KINDS),
    text: z.string().optional(),
  }),
}) satisfies z.ZodType<ReleasedEntry>

export function parseReleaseReceipt(value: unknown): ReleaseReceipt | undefined {
  const result = releaseReceiptSchema.safeParse(value)
  return result.success ? result.data : undefined
}

/** The release receipt a tool result carries, if it carries one at all. */
export function releaseReceiptFromContent(content: readonly ContentBlock[]): ReleaseReceipt | undefined {
  for (const block of content) {
    if (block.type !== 'text')
      continue
    try {
      const parsed = parseReleaseReceipt(JSON.parse(block.text))
      if (parsed)
        return parsed
    }
    catch { }
  }
  return undefined
}

export function releaseContent(value: ReleaseReceipt): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * The release records a message carries.
 *
 * The message source is a union the host owns and this plugin only fills in
 * one member of, so the records are read structurally: only this plugin's own
 * catalog form carries them.
 */
export function releasedOf(source: unknown): ReleasedEntry[] {
  if (typeof source !== 'object' || source === null)
    return []
  const candidate = source as { kind?: unknown, form?: unknown, released?: unknown }
  if (candidate.kind !== ACTIVATOR_SOURCE_KIND || candidate.form !== CATALOG_FORM)
    return []
  const parsed = z.array(releasedEntrySchema).safeParse(candidate.released)
  return parsed.success ? parsed.data : []
}
