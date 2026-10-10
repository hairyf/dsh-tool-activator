import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ToolGroup, ToolPolicy } from '../shared'
import type { ConfigMutationOps, PolicyDraftValidation, ToolPolicyDraft } from './types'
import { DEFAULT_POLICY } from '../shared'
import { GROUP_FIELDS, TOOL_NAME_PATTERN } from './constants'

export function canWriteConfiguration(form: ConfigPageForm | undefined): boolean {
  const state = form?.state
  return state?.status === 'ready'
    && state.value !== undefined
    && state.mode === 'host'
    && state.writable
    && Number.isSafeInteger(state.revision)
    && state.revision !== undefined
    && state.revision >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

export function createPolicyDraft(value: Record<string, unknown> | undefined): ToolPolicyDraft {
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_POLICY.enabled,
    mode: value?.mode === 'manual' ? 'manual' : DEFAULT_POLICY.mode,
    basicToolsText: isStringArray(value?.basicTools) ? value.basicTools.join('\n') : DEFAULT_POLICY.basicTools.join('\n'),
    excludedToolsText: isStringArray(value?.excludedTools) ? value.excludedTools.join('\n') : DEFAULT_POLICY.excludedTools.join('\n'),
    requireApproval: typeof value?.requireApproval === 'boolean' ? value.requireApproval : DEFAULT_POLICY.requireApproval,
    autoGroupMcp: typeof value?.autoGroupMcp === 'boolean' ? value.autoGroupMcp : DEFAULT_POLICY.autoGroupMcp,
    groupsText: JSON.stringify(Array.isArray(value?.groups) ? value.groups : DEFAULT_POLICY.groups, null, 2),
    sectionToolsText: JSON.stringify(isRecord(value?.sectionTools) ? value.sectionTools : DEFAULT_POLICY.sectionTools, null, 2),
  }
}

function toolNames(text: string, label: string): string[] {
  const names = [...new Set(text.split(/\r?\n/u).map(name => name.trim()).filter(Boolean))]
  if (names.some(name => !TOOL_NAME_PATTERN.test(name)))
    throw new Error(`${label}每行填写一个真实工具名，只能包含字母、数字、下划线、点和连字符。`)
  return names
}

function jsonValue(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    throw new Error(`${label}不是有效 JSON。`)
  }
}

function readGroups(text: string): ToolGroup[] {
  const value = jsonValue(text, '工具分组')
  if (!Array.isArray(value))
    throw new Error('工具分组必须是 JSON 数组。')
  const identifiers = new Set<string>()
  const claimedTools = new Set<string>()
  return value.map((item: unknown, index: number): ToolGroup => {
    const label = `第 ${index + 1} 个工具分组`
    if (!isRecord(item) || Object.keys(item).some(key => !GROUP_FIELDS.has(key)))
      throw new Error(`${label}只接受 identifier、name、description、tools 和 sections。`)
    if (typeof item.identifier !== 'string' || !TOOL_NAME_PATTERN.test(item.identifier))
      throw new Error(`${label}需要有效的 identifier（字母、数字、下划线、点或连字符）。`)
    if (identifiers.has(item.identifier))
      throw new Error(`工具分组 identifier 重复：${item.identifier}。`)
    identifiers.add(item.identifier)
    if (item.name !== undefined && typeof item.name !== 'string')
      throw new Error(`${label}的 name 必须是字符串。`)
    if (item.description !== undefined && typeof item.description !== 'string')
      throw new Error(`${label}的 description 必须是字符串。`)
    if (!isStringArray(item.tools) || item.tools.length === 0 || item.tools.some(name => !TOOL_NAME_PATTERN.test(name)))
      throw new Error(`${label}的 tools 至少包含一个有效工具名。`)
    for (const name of item.tools) {
      if (claimedTools.has(name))
        throw new Error(`工具 ${name} 不能同时属于多个分组或在分组内重复。`)
      claimedTools.add(name)
    }
    if (item.sections !== undefined && !isStringArray(item.sections))
      throw new Error(`${label}的 sections 必须是字符串数组。`)
    return {
      identifier: item.identifier,
      name: typeof item.name === 'string' ? item.name : '',
      description: typeof item.description === 'string' ? item.description : '',
      tools: [...item.tools],
      sections: isStringArray(item.sections) ? [...item.sections] : [],
    }
  })
}

function readSectionTools(text: string): Readonly<Record<string, readonly string[]>> {
  const value = jsonValue(text, '说明节依赖')
  if (!isRecord(value))
    throw new Error('说明节依赖必须是 JSON 对象。')
  const entries = Object.entries(value).map(([section, names]): [string, string[]] => {
    if (!isStringArray(names) || names.some(name => !TOOL_NAME_PATTERN.test(name)))
      throw new Error('说明节依赖需要说明节名称和有效工具名数组。')
    return [section, [...new Set(names)]]
  })
  return Object.fromEntries(entries)
}

export function validatePolicyDraft(draft: ToolPolicyDraft): PolicyDraftValidation {
  try {
    const policy: ToolPolicy = {
      enabled: draft.enabled,
      mode: draft.mode,
      basicTools: toolNames(draft.basicToolsText, '基础工具'),
      excludedTools: toolNames(draft.excludedToolsText, '排除工具'),
      requireApproval: draft.requireApproval,
      autoGroupMcp: draft.autoGroupMcp,
      groups: readGroups(draft.groupsText),
      sectionTools: readSectionTools(draft.sectionToolsText),
    }
    return { ok: true, policy }
  }
  catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '配置格式无效。' }
  }
}

export function policyMutationOps(policy: ToolPolicy): ConfigMutationOps {
  return Object.entries(policy).map(([field, value]) => ({ op: 'set', path: [field], value }))
}
