import type { ConfigPageForm, PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ToolPolicy } from '../shared'

export type ToolActivatorConfigurationProps = PluginConfigViewProps

export interface ToolPolicyDraft {
  enabled: boolean
  mode: ToolPolicy['mode']
  basicToolsText: string
  excludedToolsText: string
  requireApproval: boolean
  autoGroupMcp: boolean
  groupsText: string
  sectionToolsText: string
}

export type PolicyDraftValidation
  = | { ok: true, policy: ToolPolicy }
    | { ok: false, message: string }

export interface ConfigurationFeedback {
  kind: 'success' | 'error'
  message: string
}

export interface ConfigurationEditorState {
  mutate: ConfigPageForm['mutate'] | undefined
  writable: boolean
  value: Record<string, unknown> | undefined
  revision: number | undefined
  draft: ToolPolicyDraft
  pending: boolean
  feedback: ConfigurationFeedback | undefined
}

export type ConfigMutationOps = Parameters<ConfigPageForm['mutate']>[0]
