import type { ToolGroup, ToolPolicy } from './shared'
import type { GroupProblem } from './types'
import Schema from '@deepseek-ai/schemastery'
import { GROUP_IDENTIFIER_PATTERN } from './constants'
import { DEFAULT_PASSIVE_RELEASE, DEFAULT_POLICY } from './shared'

const identifier = Schema.string().pattern(GROUP_IDENTIFIER_PATTERN).required()
const toolNames = Schema.array(identifier).default([])

/** A whole number of at least one: both passive release counts are counts. */
const count = Schema.number().step(1).min(1)

export const Config = Schema.object({
  basicTools: toolNames.default([...DEFAULT_POLICY.basicTools]).description('默认加载的真实工具名称'),
  requireApproval: Schema.boolean().default(DEFAULT_POLICY.requireApproval).description('非完全权限时激活前请求用户确认；缺少审批服务时拒绝'),
  autoGroupMcp: Schema.boolean().default(DEFAULT_POLICY.autoGroupMcp).description('按公开 mcp__server__tool 名称聚合同一 MCP 服务'),
  passiveRelease: Schema.object({
    enabled: Schema.boolean().default(DEFAULT_PASSIVE_RELEASE.enabled).description('是否开启会话工具的被动释放'),
    idleTurns: count.default(DEFAULT_PASSIVE_RELEASE.idleTurns).description('空闲多少轮后收回不再使用的已激活工具'),
    maxActivatedTools: count.default(DEFAULT_PASSIVE_RELEASE.maxActivatedTools).description('单会话已激活工具数量的软上限'),
  }).default({}).description('会话工具的被动释放策略'),
  groups: Schema.array(Schema.object({
    identifier,
    name: Schema.string().default(''),
    description: Schema.string().default(''),
    tools: toolNames,
    sections: Schema.array(Schema.string().required()).default([]),
  })).default([]).description('显式工具分组与说明节依赖；只选择当前作用域已有工具'),
  sectionTools: Schema.dict(toolNames).default({}).description('系统说明节到真实工具名称的依赖映射'),
}).default({}).volatile()

export type ToolActivatorConfig = ReturnType<typeof Config>

/**
 * Collects every group invariant violation of a batch in one pass, so a
 * caller can reject the whole batch and report all problems at once instead
 * of the first one only.
 */
export function collectGroupProblems(groups: readonly ToolGroup[]): GroupProblem[] {
  const problems: GroupProblem[] = []
  const identifierOwners = new Map<string, number>()
  const toolOwners = new Map<string, number>()
  for (const [groupIndex, group] of groups.entries()) {
    // The clash is anchored at the group that owns the identifier: renaming or
    // removing that group is what resolves it.
    const identifierOwner = identifierOwners.get(group.identifier)
    if (identifierOwner === undefined) {
      identifierOwners.set(group.identifier, groupIndex)
    }
    else {
      problems.push({
        kind: 'duplicate-identifier',
        groupIndex: identifierOwner,
        groupIdentifier: group.identifier,
        conflictingGroupIndex: groupIndex,
        reason: `Duplicate tool group identifier: ${group.identifier}`,
      })
    }
    if (group.tools.length === 0) {
      problems.push({
        kind: 'empty-group',
        groupIndex,
        groupIdentifier: group.identifier,
        reason: `Tool group ${group.identifier} must contain at least one tool`,
      })
    }
    for (const tool of group.tools) {
      const toolOwner = toolOwners.get(tool)
      if (toolOwner === undefined) {
        toolOwners.set(tool, groupIndex)
      }
      else {
        problems.push({
          kind: 'tool-in-multiple-groups',
          groupIndex,
          groupIdentifier: group.identifier,
          conflictingGroupIndex: toolOwner,
          tool,
          reason: `Tool ${tool} belongs to more than one configured group`,
        })
      }
    }
  }
  return problems
}

/**
 * Fail-fast wrapper kept for the configuration gate: the batch is still
 * rejected on its first problem, with the wording it always had.
 */
export function validatePolicy(policy: ToolPolicy): void {
  const problems = collectGroupProblems(policy.groups)
  if (problems.length > 0)
    throw new Error(problems[0].reason)
}
