import type { ToolGroupDraft } from './types'
import { GROUP_IDENTIFIER_PATTERN } from './constants'

/**
 * Whether the Host would accept this draft. The config schema requires a
 * non-empty `identifier` matching the allowed characters and forbids duplicates,
 * so an unfinished draft has to stay local instead of bouncing off the Host.
 */
export function groupsSavable(groups: readonly ToolGroupDraft[]): boolean {
  const identifiers = new Set<string>()
  const claimed = new Set<string>()
  for (const group of groups) {
    if (!GROUP_IDENTIFIER_PATTERN.test(group.identifier) || identifiers.has(group.identifier))
      return false
    identifiers.add(group.identifier)
    // The Host refuses a group without tools, so an emptied group has to stay
    // a local draft instead of bouncing off the schema and rolling the page back.
    if (group.tools.length === 0)
      return false
    for (const tool of group.tools) {
      if (claimed.has(tool) || !GROUP_IDENTIFIER_PATTERN.test(tool))
        return false
      claimed.add(tool)
    }
  }
  return true
}

/**
 * Whether a group card may offer this tool: a tool belongs to exactly one
 * place, so one the plugin locks, the default-loaded set owns, or another
 * group already holds is not a choice. Used both to build the list and to
 * drop a pick that raced another card between render and click.
 */
export function toolClaimable(
  tool: string,
  basicTools: readonly string[],
  groups: readonly ToolGroupDraft[],
  index: number,
  locked: readonly string[],
): boolean {
  if (locked.includes(tool) || basicTools.includes(tool))
    return false
  return groups.every((group, at) => at === index || !group.tools.includes(tool))
}

/**
 * The tools one group card lists: its own members first, then every tool no
 * other owner holds. A member stays listed even when it is also owned
 * elsewhere, so a legacy duplicate can still be unchecked here.
 */
export function groupChoices(
  toolNames: readonly string[],
  basicTools: readonly string[],
  groups: readonly ToolGroupDraft[],
  index: number,
  locked: readonly string[],
): string[] {
  const members = groups[index]?.tools ?? []
  const available = toolNames.filter(tool => !members.includes(tool) && toolClaimable(tool, basicTools, groups, index, locked))
  return [...members, ...available]
}

/**
 * 卡片成员里已卸载的那些，保持配置顺序。判定由宿主端随 catalog 下发，组件
 * 只做交集，不在浏览器里另起一套「安装了没有」的口径。
 */
export function missingMembers(tools: readonly string[], uninstalled: readonly string[]): string[] {
  const gone = new Set(uninstalled)
  return tools.filter(tool => gone.has(tool))
}
