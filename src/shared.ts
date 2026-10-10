export interface ToolGroup {
  identifier: string
  name: string
  description: string
  tools: readonly string[]
  sections: readonly string[]
}

export interface ToolPolicy {
  enabled: boolean
  mode: 'automatic' | 'manual'
  basicTools: readonly string[]
  excludedTools: readonly string[]
  requireApproval: boolean
  autoGroupMcp: boolean
  groups: readonly ToolGroup[]
  sectionTools: Readonly<Record<string, readonly string[]>>
}

/**
 * The tools this plugin always keeps loaded. A stored configuration can add to
 * the default set but never shrink it: these stay visible with full schemas
 * even when the profile pins an older `basicTools` list.
 */
export const BASE_TOOLS: readonly string[] = ['read', 'glob', 'grep', 'write', 'edit', 'skill', 'ask_user_question', 'todo_write']

export const DEFAULT_POLICY: ToolPolicy = {
  enabled: true,
  mode: 'automatic',
  basicTools: [...BASE_TOOLS],
  excludedTools: [],
  requireApproval: true,
  autoGroupMcp: true,
  groups: [],
  sectionTools: {},
}

export function withBaseTools(policy: ToolPolicy): ToolPolicy {
  return { ...policy, basicTools: [...new Set([...BASE_TOOLS, ...policy.basicTools])] }
}

export const PACKAGE_NAME = 'dsh-tool-activator'
export const CONFIG_ROW_ID = 'tool-activator'
export const MINIMUM_CORE_VERSION = '0.2.0-rc.2'
