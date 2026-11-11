import type { ToolGroup, ToolPolicy } from './shared'
import { describe, expect, it } from 'vitest'
import { collectGroupProblems, Config, validatePolicy } from './config'
import { DEFAULT_PASSIVE_RELEASE } from './shared'

function parse(value: unknown): ToolPolicy {
  return Config(value as Parameters<typeof Config>[0]).get()
}

function policy(groups: readonly ToolGroup[]): ToolPolicy {
  return {
    basicTools: ['read'],
    requireApproval: true,
    autoGroupMcp: true,
    passiveRelease: { ...DEFAULT_PASSIVE_RELEASE },
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
      passiveRelease: { enabled: true, idleTurns: 6, maxActivatedTools: 24 },
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
      passiveRelease: { enabled: true, idleTurns: 6, maxActivatedTools: 24 },
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
      passiveRelease: { enabled: true, idleTurns: 6, maxActivatedTools: 24 },
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

  it('keeps an explicit passive release policy', () => {
    const result = parse({ passiveRelease: { enabled: false, idleTurns: 3, maxActivatedTools: 12 } })

    expect(result.passiveRelease).toEqual({ enabled: false, idleTurns: 3, maxActivatedTools: 12 })
  })

  it('fills a partial passive release policy from the defaults', () => {
    const result = parse({ passiveRelease: { enabled: false } })

    expect(result.passiveRelease).toEqual({ enabled: false, idleTurns: 6, maxActivatedTools: 24 })
  })

  it.each([
    { idleTurns: 0 },
    { idleTurns: -1 },
    { idleTurns: 1.5 },
    { idleTurns: '6' },
    { maxActivatedTools: 0 },
    { maxActivatedTools: 2.5 },
    { maxActivatedTools: '24' },
  ])('rejects a passive release count that is not a whole number of at least one %j', (block) => {
    expect(() => parse({ passiveRelease: block })).toThrow()
  })

  it('accepts a passive release cap larger than the number of installed tools', () => {
    // The cap is lazy: a limit above the tool count simply never triggers.
    const result = parse({ passiveRelease: { maxActivatedTools: 9999 } })

    expect(result.passiveRelease.maxActivatedTools).toBe(9999)
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

describe('collectGroupProblems', () => {
  it('reports nothing for disjoint nonempty groups', () => {
    expect(collectGroupProblems([group('files', ['read']), group('web', ['write'])])).toEqual([])
  })

  it('locates a duplicate identifier by the owning group and the group that clashes with it', () => {
    const problems = collectGroupProblems([group('files', ['read']), group('files', ['write'])])

    expect(problems).toHaveLength(1)
    expect(problems[0]).toEqual({
      kind: 'duplicate-identifier',
      groupIndex: 0,
      groupIdentifier: 'files',
      conflictingGroupIndex: 1,
      reason: 'Duplicate tool group identifier: files',
    })
  })

  it('locates an empty group by its index and identifier', () => {
    const problems = collectGroupProblems([group('files', ['read']), group('web', [])])

    expect(problems).toHaveLength(1)
    expect(problems[0]).toEqual({
      kind: 'empty-group',
      groupIndex: 1,
      groupIdentifier: 'web',
      reason: 'Tool group web must contain at least one tool',
    })
  })

  it('locates a tool claimed by more than one group', () => {
    const problems = collectGroupProblems([group('files', ['read']), group('other', ['read'])])

    expect(problems).toHaveLength(1)
    expect(problems[0]).toEqual({
      kind: 'tool-in-multiple-groups',
      groupIndex: 1,
      groupIdentifier: 'other',
      conflictingGroupIndex: 0,
      tool: 'read',
      reason: 'Tool read belongs to more than one configured group',
    })
  })

  it('returns every problem of a broken batch at once instead of stopping at the first one', () => {
    const problems = collectGroupProblems([
      group('files', ['read']),
      group('files', []),
      group('other', ['read']),
    ])

    expect(problems.map(problem => problem.kind)).toEqual([
      'duplicate-identifier',
      'empty-group',
      'tool-in-multiple-groups',
    ])
    expect(problems[0]).toMatchObject({ groupIndex: 0, groupIdentifier: 'files', conflictingGroupIndex: 1 })
    expect(problems[1]).toMatchObject({ groupIndex: 1, groupIdentifier: 'files' })
    expect(problems[2]).toMatchObject({ groupIndex: 2, groupIdentifier: 'other', tool: 'read' })
  })

  it('keeps validatePolicy throwing only the first problem with the established wording', () => {
    const groups = [group('files', ['read']), group('files', []), group('other', ['read'])]

    expect(() => validatePolicy(policy(groups))).toThrow('Duplicate tool group identifier: files')
  })
})
