export interface ToolGroup {
  identifier: string
  name: string
  description: string
  tools: readonly string[]
  sections: readonly string[]
}

export interface ToolPolicy {
  basicTools: readonly string[]
  requireApproval: boolean
  autoGroupMcp: boolean
  groups: readonly ToolGroup[]
  sectionTools: Readonly<Record<string, readonly string[]>>
}

/** Factory defaults; an explicit basicTools list may add or remove any of these. */
export const BASE_TOOLS: readonly string[] = ['read', 'glob', 'grep', 'write', 'edit', 'skill', 'ask_user_question', 'todo_write']

export const DEFAULT_POLICY: ToolPolicy = {
  basicTools: [...BASE_TOOLS],
  requireApproval: true,
  autoGroupMcp: true,
  groups: [],
  sectionTools: {},
}

export const PACKAGE_NAME = 'dsh-tool-activator'
export const CONFIG_ROW_ID = 'tool-activator'
export const MINIMUM_CORE_VERSION = '0.2.0-rc.2'
