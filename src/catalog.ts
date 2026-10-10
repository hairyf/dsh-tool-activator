import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolPolicy } from './shared'
import type { ToolCatalogItem } from './types'
import { validatePolicy } from './config'
import { ACTIVATOR_TOOL_NAME, FIRST_PARTY_SECTION_TOOLS } from './constants'

export function buildToolCatalog(schemas: readonly ToolSchema[], policy: ToolPolicy): ToolCatalogItem[] {
  validatePolicy(policy)
  const available = new Map(schemas
    .filter(tool => tool.name !== ACTIVATOR_TOOL_NAME && tool.name !== 'run_code' && !policy.excludedTools.includes(tool.name))
    .map(tool => [tool.name, tool]))
  const claimed = new Set<string>()
  const entries: ToolCatalogItem[] = []

  const add = (identifier: string, names: readonly string[], name = identifier, description = '', sections: readonly string[] = []): void => {
    const tools = [...new Set(names)].flatMap((toolName) => {
      const tool = available.get(toolName)
      return tool && !claimed.has(toolName) ? [tool] : []
    })
    if (tools.length === 0)
      return
    tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    tools.forEach(tool => claimed.add(tool.name))
    entries.push({
      identifier,
      name: name || identifier,
      description: description || tools.map(tool => `${tool.name}: ${tool.description}`).join('\n'),
      apiDescriptions: tools.map(tool => ({ name: tool.name, description: tool.description })),
      tools,
      sections: [...sections],
    })
  }

  for (const group of policy.groups)
    add(group.identifier, group.tools, group.name, group.description, group.sections)

  if (policy.autoGroupMcp) {
    const servers = new Map<string, string[]>()
    for (const tool of available.values()) {
      const server = /^mcp__([\w-]+?)__/u.exec(tool.name)?.[1]
      if (!server || claimed.has(tool.name))
        continue
      const names = servers.get(server) ?? []
      names.push(tool.name)
      servers.set(server, names)
    }
    for (const [server, names] of servers)
      add(`mcp.${server}`, names, server, '', [`mcp:${server}`])
  }

  for (const tool of available.values()) {
    if (!claimed.has(tool.name))
      add(tool.name, [tool.name])
  }

  const identifiers = new Set<string>()
  for (const entry of entries) {
    if (identifiers.has(entry.identifier))
      throw new Error(`Ambiguous tool identifier ${entry.identifier}; configure a unique group identifier`)
    identifiers.add(entry.identifier)
  }
  return entries.sort((a, b) => a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0)
}

export function enabledToolNames(catalog: readonly ToolCatalogItem[], policy: ToolPolicy, activatedIds: readonly string[]): Set<string> {
  const enabled = new Set<string>([ACTIVATOR_TOOL_NAME, 'run_code'])
  const active = new Set(activatedIds)
  for (const entry of catalog) {
    for (const tool of entry.tools) {
      if (policy.basicTools.includes(tool.name) || (policy.mode === 'automatic' && active.has(entry.identifier)))
        enabled.add(tool.name)
    }
  }
  if (policy.mode === 'manual')
    enabled.delete(ACTIVATOR_TOOL_NAME)
  return enabled
}

export function availableToolsForDiscovery(catalog: readonly ToolCatalogItem[], enabledNames: ReadonlySet<string>): ToolCatalogItem[] {
  return catalog.filter(entry => entry.tools.some(tool => !enabledNames.has(tool.name)))
}

export function sectionToolDependencies(catalog: readonly ToolCatalogItem[], policy: ToolPolicy): Record<string, string[]> {
  const mapping = new Map<string, string[]>(Object.entries(FIRST_PARTY_SECTION_TOOLS).map(([key, names]) => [key, [...names]]))
  for (const entry of catalog) {
    for (const section of entry.sections) {
      const names = mapping.get(section) ?? []
      mapping.set(section, [...new Set([...names, ...entry.tools.map(tool => tool.name)])])
    }
  }
  for (const [section, names] of Object.entries(policy.sectionTools))
    mapping.set(section, [...names])
  return Object.fromEntries(mapping)
}
