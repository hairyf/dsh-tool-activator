import type { PassiveReleasePolicy } from '../shared'
import type { PassiveReleaseDraft } from './types'
import { DEFAULT_PASSIVE_RELEASE } from '../shared'

/**
 * Reads the document's passive release block into a draft.
 *
 * A block the document does not carry falls back to the schema defaults; a
 * value the Host would refuse is kept as it is, so the page can say why the
 * draft is not savable instead of silently replacing what the user typed.
 */
export function readPassiveReleaseDraft(value: unknown): PassiveReleaseDraft {
  const block = readBlock(value)
  return {
    enabled: typeof block.enabled === 'boolean' ? block.enabled : DEFAULT_PASSIVE_RELEASE.enabled,
    idleTurns: readCount(block.idleTurns, DEFAULT_PASSIVE_RELEASE.idleTurns),
    maxActivatedTools: readCount(block.maxActivatedTools, DEFAULT_PASSIVE_RELEASE.maxActivatedTools),
  }
}

/**
 * Whether the Host would accept this draft. The config schema wants both
 * counts to be whole numbers of at least one, so an unfinished value has to
 * stay local instead of bouncing off the Host and rolling the page back.
 */
export function passiveReleaseSavable(draft: PassiveReleaseDraft): boolean {
  return countOf(draft.idleTurns) !== undefined && countOf(draft.maxActivatedTools) !== undefined
}

/** The block the Host document stores, or undefined when the draft is not savable. */
export function passiveReleaseValue(draft: PassiveReleaseDraft): PassiveReleasePolicy | undefined {
  const idleTurns = countOf(draft.idleTurns)
  const maxActivatedTools = countOf(draft.maxActivatedTools)
  if (idleTurns === undefined || maxActivatedTools === undefined)
    return undefined
  return { enabled: draft.enabled, idleTurns, maxActivatedTools }
}

/**
 * Why a count cannot be saved, or an empty string when it can.
 *
 * Both counts of the passive release policy are whole numbers of at least one,
 * so they share the rule and differ only in the words that name the field.
 */
export function countProblem(text: string, message: string): string {
  return countOf(text) === undefined ? message : ''
}

/** The document block, or an empty one when the document carries none. */
function readBlock(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** The text of a count the document carries, or the default when it carries none. */
function readCount(value: unknown, fallback: number): string {
  if (value === undefined || value === null)
    return String(fallback)
  return String(value)
}

/** The whole number the input holds, or undefined when it is not one. */
function countOf(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/u.test(trimmed))
    return undefined
  const value = Number(trimmed)
  return value >= 1 ? value : undefined
}
