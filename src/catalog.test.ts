import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolGroup, ToolPolicy } from './shared'
import { describe, expect, it } from 'vitest'
import { availableToolsForDiscovery, buildToolCatalog, enabledToolNames, sectionToolDependencies } from './catalog'

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    enabled: true,
    mode: 'automatic',
    basicTools: ['read'],
    excludedTools: [],
    requireApproval: true,
    autoGroupMcp: true,
    groups: [],
    sectionTools: {},
    ...overrides,
  }
}

function tool(name: string, description = `${name} description`): ToolSchema {
  return { name, description, parameters: { type: 'object', properties: {} } }
}

function group(identifier: string, tools: readonly string[], overrides: Partial<ToolGroup> = {}): ToolGroup {
  return { identifier, tools, name: '', description: '', sections: [], ...overrides }
}

describe('buildToolCatalog', () => {
  it('uses only the passed scoped schemas and never expands configured tool names', () => {
    const read = tool('read', 'Read the scoped file')
    const search = tool('web_search', 'Search this scope')
    const current = policy({
      excludedTools: ['write'],
      groups: [
        group('files', ['read', 'write', 'outside_scope'], { name: 'Files', sections: ['tool:files'] }),
        group('absent', ['not_registered']),
      ],
    })
    const schemas = [tool('activate_tools'), tool('run_code'), tool('write'), search, read]
    const result = buildToolCatalog(schemas, current)

    expect(result).toEqual([
      {
        identifier: 'files',
        name: 'Files',
        description: 'read: Read the scoped file',
        apiDescriptions: [{ name: 'read', description: 'Read the scoped file' }],
        tools: [read],
        sections: ['tool:files'],
      },
      {
        identifier: 'web_search',
        name: 'web_search',
        description: 'web_search: Search this scope',
        apiDescriptions: [{ name: 'web_search', description: 'Search this scope' }],
        tools: [search],
        sections: [],
      },
    ])
    expect(result[0]?.tools[0]).toBe(read)
    expect(schemas.map(schema => schema.name)).toEqual(['activate_tools', 'run_code', 'write', 'web_search', 'read'])
  })

  it('keeps configured metadata and sorts the actual API names rather than inventing group API names', () => {
    const z = tool('real_z')
    const a = tool('real_a')
    const result = buildToolCatalog([z, a], policy({
      groups: [group('plugin.files', ['real_z', 'missing', 'real_a'], {
        name: 'File plugin',
        description: 'Plugin usage',
        sections: ['plugin:files'],
      })],
    }))

    expect(result).toEqual([{
      identifier: 'plugin.files',
      name: 'File plugin',
      description: 'Plugin usage',
      apiDescriptions: [
        { name: 'real_a', description: 'real_a description' },
        { name: 'real_z', description: 'real_z description' },
      ],
      tools: [a, z],
      sections: ['plugin:files'],
    }])
  })

  it('rebuilds groups from the current scope after a tool is removed or added', () => {
    const current = policy({ groups: [group('editor', ['read', 'write'])] })
    const first = buildToolCatalog([tool('read'), tool('write')], current)
    const second = buildToolCatalog([tool('read')], current)
    const third = buildToolCatalog([tool('write')], current)
    const empty = buildToolCatalog([], current)

    expect(first[0]?.apiDescriptions.map(api => api.name)).toEqual(['read', 'write'])
    expect(second[0]?.apiDescriptions.map(api => api.name)).toEqual(['read'])
    expect(third[0]?.apiDescriptions.map(api => api.name)).toEqual(['write'])
    expect(empty).toEqual([])
    expect(first[0]?.tools.map(schema => schema.name)).toEqual(['read', 'write'])
    expect(current.groups[0]?.tools).toEqual(['read', 'write'])
  })

  it('groups remaining MCP schemas by their public server source with deterministic real names', () => {
    const schemas = [
      tool('mcp__zeta__z'),
      tool('mcp__alpha-beta_2__z'),
      tool('mcp__zeta__a'),
      tool('ordinary'),
      tool('mcp__alpha-beta_2__a'),
    ]
    const result = buildToolCatalog(schemas, policy())

    expect(result.map(entry => ({
      identifier: entry.identifier,
      name: entry.name,
      sections: entry.sections,
      names: entry.apiDescriptions.map(api => api.name),
    }))).toEqual([
      {
        identifier: 'mcp.alpha-beta_2',
        name: 'alpha-beta_2',
        sections: ['mcp:alpha-beta_2'],
        names: ['mcp__alpha-beta_2__a', 'mcp__alpha-beta_2__z'],
      },
      {
        identifier: 'mcp.zeta',
        name: 'zeta',
        sections: ['mcp:zeta'],
        names: ['mcp__zeta__a', 'mcp__zeta__z'],
      },
      { identifier: 'ordinary', name: 'ordinary', sections: [], names: ['ordinary'] },
    ])
    expect(buildToolCatalog([...schemas].reverse(), policy())).toEqual(result)
  })

  it('honors explicit groups before auto MCP grouping without changing callable names', () => {
    const result = buildToolCatalog([
      tool('mcp__mail__send'),
      tool('mcp__mail__list'),
      tool('mcp__mail__delete'),
    ], policy({ groups: [group('mail.read', ['mcp__mail__list'])] }))

    expect(result.map(entry => [entry.identifier, entry.tools.map(schema => schema.name)])).toEqual([
      ['mail.read', ['mcp__mail__list']],
      ['mcp.mail', ['mcp__mail__delete', 'mcp__mail__send']],
    ])
  })

  it('leaves public MCP names flat when auto grouping is disabled', () => {
    const result = buildToolCatalog([tool('mcp__mail__send'), tool('mcp__mail__list')], policy({ autoGroupMcp: false }))

    expect(result.map(entry => [entry.identifier, entry.tools.map(schema => schema.name), entry.sections])).toEqual([
      ['mcp__mail__list', ['mcp__mail__list'], []],
      ['mcp__mail__send', ['mcp__mail__send'], []],
    ])
  })

  it('deduplicates passed schema names using the current final schema', () => {
    const first = tool('read', 'Stale description')
    const current = tool('read', 'Current description')
    const result = buildToolCatalog([first, current], policy())

    expect(result).toHaveLength(1)
    expect(result[0]?.tools).toEqual([current])
    expect(result[0]?.description).toBe('read: Current description')
  })

  it('rejects overlapping configured groups even when the shared tool is absent in this scope', () => {
    expect(() => buildToolCatalog([], policy({
      groups: [group('first', ['hidden']), group('second', ['hidden'])],
    }))).toThrow('Tool hidden belongs to more than one configured group')
  })

  it('rejects identifiers ambiguous with an unclaimed flat schema', () => {
    expect(() => buildToolCatalog([tool('read'), tool('write')], policy({
      groups: [group('write', ['read'])],
    }))).toThrow('Ambiguous tool identifier write; configure a unique group identifier')
  })

  it('rejects an explicit identifier ambiguous with an auto MCP group', () => {
    expect(() => buildToolCatalog([tool('read'), tool('mcp__mail__send')], policy({
      groups: [group('mcp.mail', ['read'])],
    }))).toThrow('Ambiguous tool identifier mcp.mail; configure a unique group identifier')
  })
})

describe('enabledToolNames', () => {
  it('enables basics and activated scoped groups but no unknown or excluded tools', () => {
    const current = policy({
      excludedTools: ['write'],
      groups: [group('files', ['read', 'write']), group('web', ['web_search', 'web_fetch'])],
    })
    const catalog = buildToolCatalog([tool('read'), tool('write'), tool('web_fetch'), tool('web_search'), tool('pwsh')], current)

    expect([...enabledToolNames(catalog, current, ['web', 'unknown', 'write'])].sort()).toEqual([
      'activate_tools',
      'read',
      'run_code',
      'web_fetch',
      'web_search',
    ])
  })

  it('loads only scoped basic members of a group before activation', () => {
    const current = policy({ groups: [group('editor', ['read', 'write'])] })
    const catalog = buildToolCatalog([tool('read'), tool('write')], current)

    expect([...enabledToolNames(catalog, current, [])].sort()).toEqual(['activate_tools', 'read', 'run_code'])
    expect([...enabledToolNames(catalog, current, ['editor', 'editor'])].sort()).toEqual(['activate_tools', 'read', 'run_code', 'write'])
  })

  it('keeps manual mode basic-only despite historical activations', () => {
    const current = policy({ mode: 'manual', groups: [group('editor', ['read', 'write'])] })
    const catalog = buildToolCatalog([tool('read'), tool('write'), tool('pwsh')], current)

    expect([...enabledToolNames(catalog, current, ['editor', 'pwsh'])].sort()).toEqual(['read', 'run_code'])
  })

  it('gives exclusion priority over basic and historical activation settings', () => {
    const current = policy({ basicTools: ['read', 'write'], excludedTools: ['read', 'write'] })
    const catalog = buildToolCatalog([tool('read'), tool('write')], current)

    expect([...enabledToolNames(catalog, current, ['read', 'write'])].sort()).toEqual(['activate_tools', 'run_code'])
  })
})

describe('availableToolsForDiscovery', () => {
  it('retains partially enabled groups and removes only fully available entries', () => {
    const current = policy({ groups: [group('editor', ['read', 'write'])] })
    const catalog = buildToolCatalog([tool('read'), tool('write'), tool('web_search')], current)

    expect(availableToolsForDiscovery(catalog, new Set(['read'])).map(entry => entry.identifier)).toEqual(['editor', 'web_search'])
    expect(availableToolsForDiscovery(catalog, new Set(['read', 'write'])).map(entry => entry.identifier)).toEqual(['web_search'])
    expect(availableToolsForDiscovery(catalog, new Set(['read', 'write', 'web_search']))).toEqual([])
    expect(catalog.map(entry => entry.identifier)).toEqual(['editor', 'web_search'])
  })
})

describe('sectionToolDependencies', () => {
  it('combines current group dependencies and allows explicit mapping overrides', () => {
    const current = policy({
      groups: [
        group('files', ['read'], { sections: ['custom:all'] }),
        group('web', ['web_search'], { sections: ['custom:all'] }),
      ],
      sectionTools: { 'tool:write': ['real_write'], 'custom:all': ['read'], 'custom:none': [] },
    })
    const catalog = buildToolCatalog([tool('read'), tool('web_search')], current)
    const result = sectionToolDependencies(catalog, current)

    expect(result['tool:read']).toEqual(['read'])
    expect(result['tool:write']).toEqual(['real_write'])
    expect(result['custom:all']).toEqual(['read'])
    expect(result['custom:none']).toEqual([])
    result['custom:all']?.push('mutated')
    expect(current.sectionTools['custom:all']).toEqual(['read'])
    expect(sectionToolDependencies(catalog, current)['custom:all']).toEqual(['read'])
  })

  it('uses only surviving schemas when multiple groups share a documentation section', () => {
    const current = policy({ groups: [
      group('files', ['read', 'missing'], { sections: ['custom:all'] }),
      group('web', ['web_fetch'], { sections: ['custom:all'] }),
    ] })
    const catalog = buildToolCatalog([tool('read'), tool('web_fetch')], current)

    expect(sectionToolDependencies(catalog, current)['custom:all']).toEqual(['read', 'web_fetch'])
  })

  it('treats prototype-named sections as own dependencies and honors explicit overrides', () => {
    const prototypeSection = '__proto__'
    const current = policy({ groups: [
      group('files', ['read'], { sections: [prototypeSection, 'constructor'] }),
      group('web', ['web_fetch', 'missing'], { sections: [prototypeSection] }),
    ] })
    const catalog = buildToolCatalog([tool('read'), tool('web_fetch')], current)
    const dependencies = sectionToolDependencies(catalog, current)

    expect(Object.hasOwn(dependencies, prototypeSection)).toBe(true)
    expect(Object.hasOwn(dependencies, 'constructor')).toBe(true)
    expect(dependencies[prototypeSection]).toEqual(['read', 'web_fetch'])
    expect(dependencies.constructor).toEqual(['read'])

    const overridden = policy({
      groups: current.groups,
      sectionTools: Object.fromEntries([[prototypeSection, ['web_fetch']], ['constructor', []]]),
    })
    const result = sectionToolDependencies(catalog, overridden)

    expect(Object.hasOwn(result, prototypeSection)).toBe(true)
    expect(Object.hasOwn(result, 'constructor')).toBe(true)
    expect(result[prototypeSection]).toEqual(['web_fetch'])
    expect(result.constructor).toEqual([])
    result[prototypeSection]?.push('mutated')
    expect(overridden.sectionTools[prototypeSection]).toEqual(['web_fetch'])
    expect(sectionToolDependencies(catalog, overridden)[prototypeSection]).toEqual(['web_fetch'])
  })
})
