import type { AssembledSection, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { ToolPolicy } from './shared'
import type { ToolCatalogItem } from './types'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { availableToolsForDiscovery, sectionToolDependencies } from './catalog'
import { ACTIVATION_CONTEXT_NAME, ACTIVATOR_TOOL_NAME } from './constants'

export function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&apos;')
}

export function availableToolsPrompts(tools: readonly ToolCatalogItem[]): string {
  if (tools.length === 0)
    return ''
  const rows = tools.map(tool => `  <tool identifier="${escapeXml(tool.identifier)}" name="${escapeXml(tool.name)}">${escapeXml(tool.description)}</tool>`)
  return `<available_tools description="These tools are installed but not yet enabled. Use ${ACTIVATOR_TOOL_NAME} to enable them when needed.">\n${rows.join('\n')}\n</available_tools>`
}

export function activatorSystemPrompt(skillAvailable: boolean): string {
  const sections = [
    '# Tools Activator',
    `Only basic and already activated tools have full schemas. The <available_tools> catalog lists additional tools without their schemas. When the user requests a task, choose only the relevant identifiers and call ${ACTIVATOR_TOOL_NAME} once with all needed identifiers and a concise reason before using those tools.`,
    'After activation, use the actual callable names listed in the result and the schemas and usage instructions provided on the next model call. Do not activate tools again when they are already available.',
    'Activation changes model-facing availability, not execution permission. Existing approval, sandbox, provider, and scope restrictions remain authoritative. Unknown, removed, or excluded tools cannot be made available by guessing identifiers.',
    'When credentials are required, use an existing secure credential input mechanism. Never ask users to paste secrets into chat or claim a credential manager or sandbox integration that is not installed.',
  ]
  if (skillAvailable)
    sections.push('For tasks matching a skill in the current skill catalog, load that skill first with the existing skill tool. Tool activation may fall back to that same skill loader when no tool identifier matches.')
  return sections.join('\n\n')
}

export function selectToolSections(sections: readonly AssembledSection[], catalog: readonly ToolCatalogItem[], policy: ToolPolicy, enabledNames: ReadonlySet<string>): AssembledSection[] {
  const dependencies = sectionToolDependencies(catalog, policy)
  return sections.filter((section) => {
    const names = Object.hasOwn(dependencies, section.name) ? dependencies[section.name] : undefined
    return !names || (names.length > 0 && names.every(name => enabledNames.has(name)))
  })
}

export function activationPrompt(assembly: PromptAssembly, catalog: readonly ToolCatalogItem[], policy: ToolPolicy, enabledNames: ReadonlySet<string>, skillInstructions: readonly string[] = []): string {
  const selectedSections = selectToolSections(assembly.sections, catalog, policy, enabledNames)
  const dependencies = sectionToolDependencies(catalog, policy)
  const docs = selectedSections.filter(section => Object.hasOwn(dependencies, section.name) || section.name === 'tools:sdk')
  const parts: string[] = []
  if (policy.mode === 'automatic') {
    parts.push(activatorSystemPrompt(enabledNames.has('skill')))
    const discovery = availableToolsPrompts(availableToolsForDiscovery(catalog, enabledNames))
    if (discovery)
      parts.push(discovery)
  }
  for (const entry of catalog) {
    const visible = entry.tools.filter(tool => enabledNames.has(tool.name))
    if (visible.length === 0)
      continue
    parts.push(`<activated_tool identifier="${escapeXml(entry.identifier)}">\n${visible.map(tool => `${escapeXml(tool.name)}: ${escapeXml(tool.description)}`).join('\n')}\n</activated_tool>`)
  }
  const renderedDocs = renderPrompt({ ...assembly, sections: docs })
  if (renderedDocs)
    parts.push(renderedDocs)
  parts.push(...skillInstructions)
  return parts.join('\n\n')
}

export function filterPromptAssembly(assembly: PromptAssembly, catalog: readonly ToolCatalogItem[], policy: ToolPolicy, enabledNames: ReadonlySet<string>, sdk: string | undefined, skillInstructions: readonly string[] = []): PromptAssembly {
  if (!assembly.contexts.some(context => context.name === ACTIVATION_CONTEXT_NAME))
    throw new Error('dsh-tool-activator requires runtime context; enable it or disable the plugin for this agent')
  const prepared = {
    ...assembly,
    sections: assembly.sections.map(section => section.name === 'tools:sdk' && sdk !== undefined ? { ...section, text: sdk, interpolate: false } : section),
  }
  const dependencies = sectionToolDependencies(catalog, policy)
  return {
    ...assembly,
    tools: assembly.tools.filter(tool => enabledNames.has(tool.name)),
    sections: prepared.sections.filter(section => !Object.hasOwn(dependencies, section.name) && section.name !== 'tools:sdk'),
    variables: {
      ...assembly.variables,
      tool_activator_context: activationPrompt(prepared, catalog, policy, enabledNames, skillInstructions),
    },
  }
}
