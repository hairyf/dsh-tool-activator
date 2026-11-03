import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ReactNode } from 'react'
import type { ActivationCatalog } from '../types'

export interface ConfigurationOp {
  op: 'set'
  path: string[]
  value: unknown
}

/**
 * Only the fields this page reads. Newer platform snapshots drop `mode`, so
 * `writable` alone decides whether the Host document accepts the write.
 */
export interface ConfigurationScopeSnapshot {
  revision: number | undefined
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  writable: boolean
}

/** The config form handle the platform hands to one settings entry. */
export interface ConfigurationScope {
  getSnapshot: () => ConfigurationScopeSnapshot
  mutate: (ops: readonly ConfigurationOp[], expectedRevision?: number) => Promise<boolean>
  subscribe: (listener: () => void) => () => void
  /** Clear one field so it falls back to the plugin's own default. */
  unset?: (field: string) => Promise<boolean>
}

export interface ToolActivatorConfigurationProps extends PluginConfigViewProps {
  configScope: ConfigurationScope
  loadToolCatalog: () => Promise<ActivationCatalog>
}

/** One entry of the `groups` configuration, as the settings page edits it. */
export interface ToolGroupDraft {
  identifier: string
  name: string
  description: string
  tools: string[]
  sections: string[]
}

/**
 * The page's authoritative draft of the fields it edits. It leads the Host
 * document between a click and the echo of its write, so every control reads
 * and writes this instead of the last rendered closure.
 */
export interface ConfigurationDraft {
  basicTools: string[]
  requireApproval: boolean | undefined
  autoGroupMcp: boolean | undefined
  groups: ToolGroupDraft[] | undefined
}

/** Anything group-shaped: a draft being edited or the Host's immutable policy groups. */
export interface ToolGroupShape {
  identifier: string
  name: string
  description: string
  tools: readonly string[]
  sections: readonly string[]
}

export interface GroupsEditorProps {
  disabled?: boolean
  groups: readonly ToolGroupDraft[]
  /** Tools the default-loaded set already owns, so they are never a group choice. */
  basicTools: readonly string[]
  /** Tools the plugin itself locks on, so no group may claim them. */
  lockedTools: readonly string[]
  /** A pick another owner already holds; the page turns it into a hint. */
  onBlocked?: (tool: string) => void
  /** Every tool name the catalog knows, so a group can only reference real tools. */
  toolNames: readonly string[]
  onChange: (next: ToolGroupDraft[]) => void
}

/** A section whose body folds away; the caller owns the open state. */
export interface CollapsibleProps {
  /** Full label of the toggle, e.g. 「默认激活工具（3 个）」. */
  label: string
  open: boolean
  onToggle: (next: boolean) => void
  /** Header content beside the toggle, never inside the button. */
  actions?: ReactNode
  children?: ReactNode
}
