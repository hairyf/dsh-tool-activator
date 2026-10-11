import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ActivationCatalog } from '../types'

export interface ConfigurationOp {
  op: 'set'
  path: string[]
  value: unknown
}

export interface ConfigurationScopeSnapshot {
  mode: 'host' | 'memory'
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

export interface GroupsEditorProps {
  disabled?: boolean
  groups: readonly ToolGroupDraft[]
  /** Every tool name the catalog knows, so a group can only reference real tools. */
  toolNames: readonly string[]
  onChange: (next: ToolGroupDraft[]) => void
}
