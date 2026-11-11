import type { ToolPolicy } from './shared'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_POLICY } from './shared'

const identifier = Schema.string().pattern(/^[\w.-]+$/u).required()
const toolNames = Schema.array(identifier).default([])

export const Config = Schema.object({
  basicTools: toolNames.default([...DEFAULT_POLICY.basicTools]).description('默认加载的真实工具名称'),
  requireApproval: Schema.boolean().default(DEFAULT_POLICY.requireApproval).description('非完全权限时激活前请求用户确认；缺少审批服务时拒绝'),
  autoGroupMcp: Schema.boolean().default(DEFAULT_POLICY.autoGroupMcp).description('按公开 mcp__server__tool 名称聚合同一 MCP 服务'),
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

export function validatePolicy(policy: ToolPolicy): void {
  const claimed = new Set<string>()
  const identifiers = new Set<string>()
  for (const group of policy.groups) {
    if (identifiers.has(group.identifier))
      throw new Error(`Duplicate tool group identifier: ${group.identifier}`)
    identifiers.add(group.identifier)
    if (group.tools.length === 0)
      throw new Error(`Tool group ${group.identifier} must contain at least one tool`)
    for (const tool of group.tools) {
      if (claimed.has(tool))
        throw new Error(`Tool ${tool} belongs to more than one configured group`)
      claimed.add(tool)
    }
  }
}
