import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AssembledSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolPolicy } from './shared'
import type { AssembledPrompt, CatalogEntry, PreparedPrompt, ToolCatalogItem } from './types'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { availableToolsForDiscovery, sectionToolDependencies } from './catalog'
import { ACTIVATOR_TOOL_NAME, GROUPING_TOOL_NAME, RUN_CODE_TOOL_NAME } from './constants'

export function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&apos;')
}

export function availableToolsPrompts(tools: readonly ToolCatalogItem[]): string {
  if (tools.length === 0)
    return ''
  const rows = tools.map(tool => `  <tool identifier="${escapeXml(tool.identifier)}" name="${escapeXml(tool.name)}">${escapeXml(tool.description)}</tool>`)
  return `<available_tools description="These tools are installed but not yet enabled. Use ${ACTIVATOR_TOOL_NAME} to enable them when needed.">\n${rows.join('\n')}\n</available_tools>`
}

/**
 * The catalog is a complete state that changes whenever the enabled tools
 * change, so it is republished rather than patched: the note tells the model
 * that this copy replaces every earlier one.
 */
const CATALOG_SUPERSEDE_NOTE = 'This is the current tool catalog for this session; it supersedes any earlier tool-activator catalog in this conversation.'

/**
 * The entries the model already activated.
 *
 * Only the identifier it activates by and the member names it can now call
 * belong here: an activated tool carries its full schema in the request
 * header, so repeating the description would spend context on a second copy
 * of the same text.
 */
export function activatedToolsPrompts(catalog: readonly ToolCatalogItem[], enabledNames: ReadonlySet<string>): string {
  const rows: string[] = []
  for (const entry of catalog) {
    const names = entry.tools.filter(tool => enabledNames.has(tool.name)).map(tool => tool.name)
    if (names.length === 0)
      continue
    rows.push(`  <tool identifier="${escapeXml(entry.identifier)}" names="${escapeXml(names.join(','))}"/>`)
  }
  if (rows.length === 0)
    return ''
  return `<activated_tools>\n${rows.join('\n')}\n</activated_tools>`
}

/**
 * The entries the model can still activate, for a consumer that presents the
 * catalog as a list instead of as prose. They are exactly the entries the
 * `<available_tools>` directory lists.
 */
export function catalogEntries(catalog: readonly ToolCatalogItem[], enabledNames: ReadonlySet<string>): CatalogEntry[] {
  return availableToolsForDiscovery(catalog, enabledNames).map(entry => ({ name: entry.identifier, description: entry.description, tools: entry.tools.map(tool => tool.name) }))
}

/**
 * 全量目录的成员表（含已激活条目）。目录可选列表随激活缩小，「消失」若
 * 以它判定，会把刚激活的条目误报成已卸载；判定只认这份全量表。
 */
export function catalogMemberships(catalog: readonly ToolCatalogItem[]): CatalogEntry[] {
  return catalog.map(entry => ({ name: entry.identifier, description: entry.description, tools: entry.tools.map(tool => tool.name) }))
}
export function activatorSystemPrompt(skillAvailable: boolean): string {
  const sections = [
    '# Tools Activator',
    `Only basic and already activated tools have full schemas. The <available_tools> catalog lists additional tools without their schemas. When the user requests a task, choose only the relevant identifiers and call ${ACTIVATOR_TOOL_NAME} once with all needed identifiers and a concise reason before using those tools.`,
    'After activation, use the actual callable names listed in the result and the schemas and usage instructions provided on the next model call. Do not activate tools again when they are already available.',
    'Activation changes model-facing availability, not execution permission. Existing approval, sandbox, provider, and scope restrictions remain authoritative. Unknown, removed, or excluded tools cannot be made available by guessing identifiers.',
    `The user decides how the tools are grouped: call ${GROUPING_TOOL_NAME} only when the user explicitly asks to organize or regroup the tools, and never reorganize the catalog on your own initiative.`,
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

/**
 * The catalog the model reads about the tools it may call.
 *
 * It is one complete state: the activation rules, the directory of the tools
 * that are still on demand, the entries that are already activated, the usage
 * documentation of the enabled tools, and the instructions of the activated
 * skills.
 */
export function activationPrompt(assembly: AssembledPrompt, catalog: readonly ToolCatalogItem[], policy: ToolPolicy, enabledNames: ReadonlySet<string>, skillInstructions: readonly string[] = []): string {
  const selectedSections = selectToolSections(assembly.sections, catalog, policy, enabledNames)
  const dependencies = sectionToolDependencies(catalog, policy)
  const docs = selectedSections.filter(section => Object.hasOwn(dependencies, section.name) || section.name === 'tools:sdk')
  const parts: string[] = []
  parts.push(activatorSystemPrompt(enabledNames.has('skill')))
  parts.push(CATALOG_SUPERSEDE_NOTE)
  const discovery = availableToolsPrompts(availableToolsForDiscovery(catalog, enabledNames))
  if (discovery)
    parts.push(discovery)
  const activated = activatedToolsPrompts(catalog, enabledNames)
  if (activated)
    parts.push(activated)
  // `renderPrompt` is typed against the full assembly even though it only renders
  // sections and variables; tool declarations play no part in this text.
  const renderedDocs = renderPrompt({ ...assembly, tools: [...(assembly.tools ?? [])], sections: docs })
  if (renderedDocs)
    parts.push(renderedDocs)
  parts.push(...skillInstructions)
  return parts.join('\n\n')
}

/**
 * Split one assembly into the system prompt and the catalog.
 *
 * The system prompt must not change when a tool is activated — the provider
 * caches its prefix — so the sections that depend on the enabled tools leave
 * the prompt and travel with the catalog instead.
 */
export function preparePromptAssembly(assembly: AssembledPrompt, catalog: readonly ToolCatalogItem[], policy: ToolPolicy, enabledNames: ReadonlySet<string>, sdk: string | undefined, skillInstructions: readonly string[] = [], deferDeclarations = false): PreparedPrompt {
  const prepared = {
    ...assembly,
    sections: assembly.sections.map(section => section.name === 'tools:sdk' && sdk !== undefined ? { ...section, text: sdk, interpolate: false } : section),
  }
  const dependencies = sectionToolDependencies(catalog, policy)
  // Tool declarations are provider-owned from dsh 0.2.2 on: the waterfall receives
  // a presentation and the host merges the schemas afterwards, discarding anything
  // written back here. Skip that half of the contract instead of dereferencing a
  // missing list, and keep the sections/variables half that still applies.
  const declarations = assembly.tools
  const declarationsPatch = declarations === undefined
    ? {}
    : {
        tools: deferDeclarations
          ? deferredToolSchemas(declarations, policy)
          : declarations.filter(tool => enabledNames.has(tool.name)),
      }
  return {
    assembly: {
      ...assembly,
      ...declarationsPatch,
      sections: prepared.sections.filter(section => !Object.hasOwn(dependencies, section.name) && section.name !== 'tools:sdk'),
    },
    catalog: {
      text: activationPrompt(prepared, catalog, policy, enabledNames, skillInstructions),
      entries: catalogEntries(catalog, enabledNames),
      members: catalogMemberships(catalog),
    },
  }
}

/**
 * Keep every declaration in place so the request head stays byte-stable, and
 * defer the ones the model may not use yet. A stable head is what lets the
 * provider reuse its cached prefix; activation then only appends a
 * `tool_addition`, which is served after the cached history.
 *
 * Non-deferred declarations are required by the endpoint (it rejects a fully
 * deferred tool list), so the always-visible tools stay immediate.
 */
function deferredToolSchemas(tools: readonly ToolSchema[], policy: ToolPolicy): ToolSchema[] {
  const immediate = new Set([ACTIVATOR_TOOL_NAME, RUN_CODE_TOOL_NAME, ...policy.basicTools])
  return tools.map(tool => immediate.has(tool.name) || tool.deferLoading === true ? tool : { ...tool, deferLoading: true as const })
}

/** The head-stable tool names: always declared without deferral. */
export function immediateToolNames(policy: ToolPolicy): ReadonlySet<string> {
  return new Set([ACTIVATOR_TOOL_NAME, RUN_CODE_TOOL_NAME, ...policy.basicTools])
}
