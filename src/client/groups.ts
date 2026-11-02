import type { ToolGroupDraft } from './types'
import { GROUP_IDENTIFIER_PATTERN } from './constants'

/**
 * Whether the Host would accept this draft. The config schema requires a
 * non-empty `identifier` matching the allowed characters and forbids duplicates,
 * so an unfinished draft has to stay local instead of bouncing off the Host.
 */
export function groupsSavable(groups: readonly ToolGroupDraft[]): boolean {
  const seen = new Set<string>()
  for (const group of groups) {
    if (!GROUP_IDENTIFIER_PATTERN.test(group.identifier) || seen.has(group.identifier))
      return false
    seen.add(group.identifier)
  }
  return true
}
