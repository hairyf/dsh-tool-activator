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
}

export interface ToolActivatorConfigurationProps extends PluginConfigViewProps {
  configScope: ConfigurationScope
  loadToolCatalog: () => Promise<ActivationCatalog>
}
