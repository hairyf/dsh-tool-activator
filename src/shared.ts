export interface ToolGroup {
  identifier: string
  name: string
  description: string
  tools: readonly string[]
  sections: readonly string[]
}

/**
 * The passive release policy: what a session may keep activated, and for how
 * long an untouched activation may stay.
 */
export interface PassiveReleasePolicy {
  /** Whether the passive policy runs at all; an active release never needs it. */
  enabled: boolean
  /** Idle turns before an unused activated entry is reclaimed. */
  idleTurns: number
  /** Soft cap on the activated tools one session may hold. */
  maxActivatedTools: number
}

export interface ToolPolicy {
  basicTools: readonly string[]
  requireApproval: boolean
  autoGroupMcp: boolean
  passiveRelease: PassiveReleasePolicy
  groups: readonly ToolGroup[]
  sectionTools: Readonly<Record<string, readonly string[]>>
}

/** Factory defaults; an explicit basicTools list may add or remove any of these. */
export const BASE_TOOLS: readonly string[] = ['read', 'glob', 'grep', 'write', 'edit', 'skill', 'ask_user_question', 'todo_write']

/** The passive release policy a document without one falls back to. */
export const DEFAULT_PASSIVE_RELEASE: PassiveReleasePolicy = {
  enabled: true,
  idleTurns: 6,
  maxActivatedTools: 24,
}

export const DEFAULT_POLICY: ToolPolicy = {
  basicTools: [...BASE_TOOLS],
  requireApproval: true,
  autoGroupMcp: true,
  passiveRelease: { ...DEFAULT_PASSIVE_RELEASE },
  groups: [],
  sectionTools: {},
}

export const PACKAGE_NAME = 'dsh-tool-activator'
export const CONFIG_ROW_ID = 'tool-activator'
export const MINIMUM_CORE_VERSION = '0.2.0-rc.2'
