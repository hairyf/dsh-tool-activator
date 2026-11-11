import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolGroup } from './shared'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-activator': { kind: 'tool-activator' }
  }
}

export interface ActivateToolsParams {
  identifiers: string[]
  reason: string
}

export interface ActivateSkillParams {
  name: string
}

export interface ActivatedToolInfo {
  apiCount: number
  avatar?: string
  identifier: string
  name: string
}

export interface ActivateToolsState {
  activatedSkills: unknown[]
  activatedTools: ActivatedToolInfo[]
  alreadyActive: string[]
  notFound: string[]
}

export interface ActivationResult {
  content: string
  state?: ActivateToolsState | unknown
  success: boolean
}

export interface ToolManifestInfo {
  apiDescriptions: Array<{ description: string, name: string }>
  avatar?: string
  identifier: string
  name: string
  systemRole?: string
}

export interface ActivatorRuntimeService {
  activateSkill?: (args: ActivateSkillParams) => Promise<ActivationResult>
  explainNotFound?: (identifier: string) => string | undefined
  getActivatedToolIds: () => string[]
  getToolManifests: (identifiers: string[]) => Promise<ToolManifestInfo[]>
  markActivated: (identifiers: string[]) => void
}

export interface AvailableToolItem {
  description: string
  identifier: string
  name: string
}

export interface ToolCatalogItem extends ToolManifestInfo {
  description: string
  tools: ToolSchema[]
  sections: string[]
}

export interface ActivatedSkillInfo {
  id: string
  name: string
  description: string
  source: string
  title: string
  hasResources: boolean
  provider?: string
  instructions?: string
}

export interface ActivationEnvelope {
  producer: 'dsh-tool-activator'
  version: 1
  content: string
  success: boolean
  state: {
    activatedTools: ActivatedToolInfo[]
    activatedSkills: ActivatedSkillInfo[]
    alreadyActive: string[]
    notFound: string[]
  }
}

export interface ActivationReceipt extends ActivationEnvelope {
  authorized: true
  approvalRequired: boolean
  commit: ActivationCommit
}

export interface ActivationHistory {
  activatedToolIds: string[]
  activatedSkills: ActivatedSkillInfo[]
  pendingCalls: string[]
  pendingActivations?: Array<{ callId: string, parentCallId: string, activation: ActivationReceipt }>
  pendingRequests?: Array<{ callId: string, identifiers: string[] }>
  approvalRequests?: Array<{ id: string, callId: string }>
  approvedCalls?: string[]
}

export interface ActivationCommit {
  producer: 'dsh-tool-activator'
  version: 1
  callId: string
  activatedToolIds: string[]
  activatedSkills: ActivatedSkillInfo[]
}

export interface ActivationCatalogEntry {
  identifier: string
  name: string
  description: string
  tools: string[]
}

export interface ActivationCatalog {
  autoGroupMcp: boolean
  basicTools: string[]
  baseTools: string[]
  entries: ActivationCatalogEntry[]
  groups: ToolGroup[]
  requireApproval: boolean
}
