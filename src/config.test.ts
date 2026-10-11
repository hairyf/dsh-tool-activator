import type { ToolGroup, ToolPolicy } from './shared'
import { describe, expect, it } from 'vitest'
import { Config, validatePolicy } from './config'

function parse(value: unknown): ToolPolicy {
  return Config(value as Parameters<typeof Config>[0]).get()
}

function policy(groups: readonly ToolGroup[]): ToolPolicy {
  return {
    basicTools: ['read'],
    requireApproval: true,
    autoGroupMcp: true,
    groups,
    sectionTools: {},
  }
}

function group(identifier: string, tools: readonly string[]): ToolGroup {
  return { identifier, tools, name: '', description: '', sections: [] }
}

describe('config', () => {
  it('provides literal defaults through the public volatile config contract', () => {
    const result = Config({})

    expect(result.get()).toEqual({
      basicTools: ['read', 'glob', 'grep', 'write', 'edit', 'skill', 'ask_user_question', 'todo_write'],
      requireApproval: true,
      autoGroupMcp: true,
      groups: [],
      sectionTools: {},
    })
    expect(parse(undefined)).toEqual(result.get())
  })

  it('preserves explicit false values and empty basic lists', () => {
    expect(parse({ basicTools: [], requireApproval: false, autoGroupMcp: false })).toEqual({
      basicTools: [],
      requireApproval: false,
      autoGroupMcp: false,
      groups: [],
      sectionTools: {},
    })
  })

  it('normalizes group metadata without inventing tool schemas or trimming configured scope names', () => {
    expect(parse({
      basicTools: ['read', 'read'],
      groups: [{ identifier: 'plugin.files-2', tools: ['mcp__files__read', 'not_in_current_scope'] }],
      sectionTools: { 'plugin:files': ['mcp__files__read'], 'tool:none': [] },
    })).toEqual({
      basicTools: ['read', 'read'],
      requireApproval: true,
      autoGroupMcp: true,
      groups: [{ identifier: 'plugin.files-2', name: '', description: '', tools: ['mcp__files__read', 'not_in_current_scope'], sections: [] }],
      sectionTools: { 'plugin:files': ['mcp__files__read'], 'tool:none': [] },
    })
  })

  it('preserves user-authored display names, descriptions, and section identities', () => {
    const result = parse({ groups: [{ identifier: 'files', name: '文件 & Tools', description: 'Read <files> safely', tools: ['read'], sections: ['plugin:files', 'custom:safety'] }] })

    expect(result.groups).toEqual([{ identifier: 'files', name: '文件 & Tools', description: 'Read <files> safely', tools: ['read'], sections: ['plugin:files', 'custom:safety'] }])
  })

  it.each([
    { requireApproval: 1 },
    { autoGroupMcp: 'false' },
    { basicTools: 'read' },
    { groups: 'files' },
    { sectionTools: { 'tool:read': 'read' } },
  ])('rejects invalid configuration field types %j', (input) => {
    expect(() => parse(input)).toThrow()
  })

  it.each(['with space', 'server/tool', 'mcp:server', '', '工具'])('rejects invalid actual tool identifiers %j', (name) => {
    expect(() => parse({ basicTools: [name] })).toThrow()
    expect(() => parse({ groups: [{ identifier: name, tools: ['read'] }] })).toThrow()
    expect(() => parse({ groups: [{ identifier: 'files', tools: [name] }] })).toThrow()
    expect(() => parse({ sectionTools: { 'tool:files': [name] } })).toThrow()
  })

  it('keeps the basic default independent from an explicit list', () => {
    const first = parse({ basicTools: ['write'] })
    const second = parse({})

    expect(first.basicTools).toEqual(['write'])
    expect(second.basicTools).toEqual(['read', 'glob', 'grep', 'write', 'edit', 'skill', 'ask_user_question', 'todo_write'])
  })
})

describe('validatePolicy', () => {
  it('accepts disjoint nonempty groups, including currently unavailable schema names', () => {
    expect(() => validatePolicy(policy([group('files', ['read', 'write']), group('web', ['web_search', 'not_registered'])]))).not.toThrow()
    expect(() => validatePolicy(policy([]))).not.toThrow()
  })

  it('rejects duplicate group identifiers before interpreting scope availability', () => {
    expect(() => validatePolicy(policy([group('files', ['read']), group('files', ['write'])]))).toThrow('Duplicate tool group identifier: files')
  })

  it('rejects empty groups instead of creating empty discoverable entries', () => {
    expect(() => validatePolicy(policy([group('files', [])]))).toThrow('Tool group files must contain at least one tool')
  })

  it('rejects tool membership overlap between configured groups', () => {
    expect(() => validatePolicy(policy([group('files', ['read']), group('other', ['read'])]))).toThrow('Tool read belongs to more than one configured group')
  })

  it('rejects duplicate configured membership rather than silently normalizing configuration', () => {
    expect(() => validatePolicy(policy([group('files', ['read', 'read'])]))).toThrow('Tool read belongs to more than one configured group')
  })
})
