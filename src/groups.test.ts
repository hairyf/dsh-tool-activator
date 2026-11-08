import type { GroupingFacts } from './groups'
import type { ToolGroup } from './shared'
import type { GroupView } from './types'
import { describe, expect, it } from 'vitest'
import { applyGroupOps, groupingSnapshot } from './groups'

const LOCKED = ['activate_tools', 'group_tools', 'run_code']

function group(identifier: string, tools: string[]): ToolGroup {
  return { identifier, name: identifier.toUpperCase(), description: `${identifier} description`, tools, sections: [] }
}

/**
 * The always-loaded tools are addressed as a group, so the snapshot shows them
 * as one whose members the scope may not offer.
 */
function basicView(basicTools: readonly string[], installed: readonly string[]): GroupView {
  return {
    identifier: 'basic',
    name: 'Basic tools',
    description: 'Always loaded. The model may add or remove members; the group itself cannot be created or deleted.',
    tools: [...new Set(basicTools)].sort().map(name => installed.includes(name) ? { name } : { name, missing: true }),
  }
}

describe('groupingSnapshot', () => {
  it('lists every configured group with its members in the configured order', () => {
    const snapshot = groupingSnapshot({
      groups: [group('files', ['write', 'read'])],
      tools: ['read', 'write', 'web_search'],
      basicTools: ['read'],
      lockedTools: LOCKED,
    })

    expect(snapshot.groups).toEqual([
      basicView(['read'], ['read', 'write', 'web_search']),
      { identifier: 'files', name: 'FILES', description: 'files description', tools: [{ name: 'write' }, { name: 'read' }] },
    ])
  })

  it('keeps a group that no longer has its tools, in the configured order', () => {
    const snapshot = groupingSnapshot({
      groups: [group('zulu', ['read']), group('alpha', ['write'])],
      tools: ['read', 'write'],
      basicTools: [],
      lockedTools: LOCKED,
    })

    expect(snapshot.groups.map(entry => entry.identifier)).toEqual(['basic', 'zulu', 'alpha'])
  })

  it('flags a member that no longer exists instead of dropping it', () => {
    const snapshot = groupingSnapshot({
      groups: [group('files', ['read', 'gone'])],
      tools: ['read'],
      basicTools: [],
      lockedTools: LOCKED,
    })

    expect(snapshot.groups[1]?.tools).toEqual([{ name: 'read' }, { name: 'gone', missing: true }])
    expect(snapshot.unclaimed).not.toContain('gone')
  })

  it('leaves the unclaimed tools to the ones no group, the basic set or the locked set claims', () => {
    const snapshot = groupingSnapshot({
      groups: [group('files', ['web_search'])],
      tools: ['read', 'web_search', 'pwsh', 'activate_tools', 'run_code', 'group_tools'],
      basicTools: ['read'],
      lockedTools: LOCKED,
    })

    expect(snapshot.unclaimed).toEqual(['pwsh'])
  })

  it('keeps a basic tool that is also a group member a member', () => {
    const snapshot = groupingSnapshot({
      groups: [group('files', ['read'])],
      tools: ['read', 'pwsh'],
      basicTools: ['read'],
      lockedTools: LOCKED,
    })

    expect(snapshot.groups[1]?.tools).toEqual([{ name: 'read' }])
    expect(snapshot.unclaimed).toEqual(['pwsh'])
  })

  it('sorts the unclaimed, basic and locked names ascending', () => {
    const snapshot = groupingSnapshot({
      groups: [],
      tools: ['zeta', 'alpha', 'mu'],
      basicTools: ['write', 'read'],
      lockedTools: ['run_code', 'activate_tools', 'group_tools'],
    })

    expect(snapshot.unclaimed).toEqual(['alpha', 'mu', 'zeta'])
    expect(snapshot.basic).toEqual(['read', 'write'])
    expect(snapshot.locked).toEqual(['activate_tools', 'group_tools', 'run_code'])
  })

  it('reports no groups and every free tool when nothing is configured', () => {
    const snapshot = groupingSnapshot({
      groups: [],
      tools: ['pwsh', 'read', 'web_search'],
      basicTools: ['read'],
      lockedTools: LOCKED,
    })

    expect(snapshot.groups).toEqual([basicView(['read'], ['pwsh', 'read', 'web_search'])])
    expect(snapshot.unclaimed).toEqual(['pwsh', 'web_search'])
  })

  it('reports no free tool once every tool is claimed', () => {
    const snapshot = groupingSnapshot({
      groups: [group('files', ['pwsh', 'web_search'])],
      tools: ['pwsh', 'web_search', 'read'],
      basicTools: ['read'],
      lockedTools: LOCKED,
    })

    expect(snapshot.unclaimed).toEqual([])
  })
})

/** The facts the engine reads: one scope, its tools, and the two reserved sets. */
function facts(overrides: Partial<GroupingFacts> = {}): GroupingFacts {
  return {
    groups: [],
    tools: ['pwsh', 'web_search', 'read'],
    basicTools: ['read'],
    lockedTools: LOCKED,
    ...overrides,
  }
}

describe('applyGroupOps', () => {
  it('adds a group and reports what it created', () => {
    const outcome = applyGroupOps(facts(), [{ op: 'add', identifier: 'files', name: 'Files', description: 'File utilities', tools: ['pwsh'] }])

    expect(outcome.problems).toEqual([])
    expect(outcome.next).toEqual([{ identifier: 'files', name: 'Files', description: 'File utilities', tools: ['pwsh'], sections: [] }])
    expect(outcome.receipt).toEqual({ created: ['files'], updated: [], removed: [], renamed: [], unchanged: [] })
  })

  it('leaves the name and the description empty when the operation omits them', () => {
    const outcome = applyGroupOps(facts(), [{ op: 'add', identifier: 'files', tools: ['pwsh'] }])

    expect(outcome.problems).toEqual([])
    expect(outcome.next).toEqual([{ identifier: 'files', name: '', description: '', tools: ['pwsh'], sections: [] }])
  })

  it('refuses an identifier that already belongs to a group', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['web_search'])] }), [{ op: 'add', identifier: 'files', tools: ['pwsh'] }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['existing-group'])
    expect(outcome.problems[0]?.groupIndex).toBe(0)
    expect(outcome.problems[0]?.opIndex).toBe(0)
    expect(outcome.next).toHaveLength(1)
    expect(outcome.receipt.created).toEqual([])
  })

  it('refuses an identifier the configuration itself would refuse', () => {
    const outcome = applyGroupOps(facts(), [{ op: 'add', identifier: 'bad id', tools: ['pwsh'] }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['invalid-identifier'])
    expect(outcome.next).toEqual([])
  })

  it('refuses a group without tools', () => {
    const missing = applyGroupOps(facts(), [{ op: 'add', identifier: 'files' }])
    const empty = applyGroupOps(facts(), [{ op: 'add', identifier: 'files', tools: [] }])

    expect(missing.problems.map(problem => problem.kind)).toEqual(['empty-tools'])
    expect(empty.problems.map(problem => problem.kind)).toEqual(['empty-tools'])
    expect(empty.next).toEqual([])
  })

  it('refuses a description that is longer than the cap and keeps one that fits', () => {
    const tooLong = applyGroupOps(facts(), [{ op: 'add', identifier: 'files', description: 'x'.repeat(121), tools: ['pwsh'] }])
    const fitting = applyGroupOps(facts(), [{ op: 'add', identifier: 'files', description: 'x'.repeat(120), tools: ['pwsh'] }])

    expect(tooLong.problems.map(problem => problem.kind)).toEqual(['description-too-long'])
    expect(fitting.problems).toEqual([])
  })

  it('refuses a member this scope does not offer', () => {
    const outcome = applyGroupOps(facts(), [{ op: 'add', identifier: 'files', tools: ['gone'] }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['unknown-tool'])
    expect(outcome.problems[0]?.tool).toBe('gone')
  })

  it('refuses a locked member', () => {
    const outcome = applyGroupOps(facts(), [{ op: 'add', identifier: 'files', tools: ['group_tools'] }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['locked-tool'])
    expect(outcome.problems[0]?.tool).toBe('group_tools')
  })

  it('refuses a basic member', () => {
    const outcome = applyGroupOps(facts(), [{ op: 'add', identifier: 'files', tools: ['read'] }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['basic-tool'])
    expect(outcome.problems[0]?.tool).toBe('read')
  })

  it('updates the reserved basic group membership instead of a configured group', () => {
    const outcome = applyGroupOps(facts(), [{ op: 'update', identifier: 'basic', tools: ['pwsh', 'web_search'] }])

    expect(outcome.problems).toEqual([])
    expect(outcome.nextBasicTools).toEqual(['pwsh', 'web_search'])
    expect(outcome.receipt.updated).toEqual(['basic'])
  })

  it('refuses to create or delete the reserved basic group', () => {
    const created = applyGroupOps(facts(), [{ op: 'add', identifier: 'basic', tools: ['pwsh'] }])
    const deleted = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'remove', identifier: 'basic' }])

    expect(created.problems.map(problem => problem.kind)).toEqual(['reserved-identifier'])
    expect(deleted.problems.map(problem => problem.kind)).toEqual(['reserved-identifier'])
  })

  it('refuses a rename onto the reserved identifier and a rename of the basic group', () => {
    const collisions = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', rename: 'basic' }])
    const renamed = applyGroupOps(facts(), [{ op: 'update', identifier: 'basic', rename: 'core' }])

    expect(collisions.problems.map(problem => problem.kind)).toEqual(['reserved-identifier'])
    expect(renamed.problems.map(problem => problem.kind)).toEqual(['immutable-basic'])
  })

  it('refuses a tool a group already carries from becoming a basic tool', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'basic', tools: ['pwsh'] }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['claimed-tool'])
  })

  it('rewrites the name of a group and keeps the fields it did not mention', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', name: 'File tools' }])

    expect(outcome.problems).toEqual([])
    expect(outcome.next).toEqual([{ identifier: 'files', name: 'File tools', description: 'files description', tools: ['pwsh'], sections: [] }])
    expect(outcome.receipt).toEqual({ created: [], updated: ['files'], removed: [], renamed: [], unchanged: [] })
  })

  it('rewrites the description of a group', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', description: 'File utilities' }])

    expect(outcome.problems).toEqual([])
    expect(outcome.next[0]?.description).toBe('File utilities')
    expect(outcome.receipt.updated).toEqual(['files'])
  })

  it('replaces the whole membership of a group instead of patching it', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', tools: ['web_search'] }])

    expect(outcome.problems).toEqual([])
    expect(outcome.next[0]?.tools).toEqual(['web_search'])
    expect(outcome.receipt.updated).toEqual(['files'])
  })

  it('renames a group and reports the mapping from the old identifier to the new one', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', rename: 'file-tools' }])

    expect(outcome.problems).toEqual([])
    expect(outcome.next[0]?.identifier).toBe('file-tools')
    expect(outcome.receipt).toEqual({ created: [], updated: ['file-tools'], removed: [], renamed: [{ from: 'files', to: 'file-tools' }], unchanged: [] })
  })

  it('renames a group whose members it did not rewrite even when one of them no longer exists', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh', 'gone'])] }), [{ op: 'update', identifier: 'files', rename: 'file-tools' }])

    expect(outcome.problems).toEqual([])
    expect(outcome.next[0]?.identifier).toBe('file-tools')
    expect(outcome.next[0]?.tools).toEqual(['pwsh', 'gone'])
    expect(outcome.receipt.renamed).toEqual([{ from: 'files', to: 'file-tools' }])
  })

  it('refuses a rename that is not an identifier the configuration would accept', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', rename: 'bad id' }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['invalid-identifier'])
    expect(outcome.next[0]?.identifier).toBe('files')
    expect(outcome.receipt.updated).toEqual([])
  })

  it('refuses a rename that hits a group that already exists', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh']), group('shell', ['web_search'])] }), [{ op: 'update', identifier: 'files', rename: 'shell' }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['existing-group'])
    expect(outcome.problems[0]?.groupIdentifier).toBe('shell')
    expect(outcome.next.map(entry => entry.identifier)).toEqual(['files', 'shell'])
  })

  it('reports an update that asks for what the group already is as unchanged', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', name: 'FILES', tools: ['pwsh'] }])

    expect(outcome.problems).toEqual([])
    expect(outcome.receipt).toEqual({ created: [], updated: [], removed: [], renamed: [], unchanged: ['files'] })
  })

  it('reports an update that names no field at all as unchanged', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files' }])

    expect(outcome.problems).toEqual([])
    expect(outcome.receipt).toEqual({ created: [], updated: [], removed: [], renamed: [], unchanged: ['files'] })
  })

  it('refuses an update of a group the configuration does not have', () => {
    const outcome = applyGroupOps(facts(), [{ op: 'update', identifier: 'files', tools: ['pwsh'] }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['unknown-group'])
    expect(outcome.problems[0]?.opIndex).toBe(0)
    expect(outcome.next).toEqual([])
  })

  it('refuses an update that empties the group', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', tools: [] }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['empty-tools'])
    expect(outcome.next[0]?.tools).toEqual(['pwsh'])
  })

  it('refuses an update whose description is longer than the cap', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', description: 'x'.repeat(121) }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['description-too-long'])
    expect(outcome.next[0]?.description).toBe('files description')
  })

  it('removes a group and reports it', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh']), group('shell', ['web_search'])] }), [{ op: 'remove', identifier: 'files' }])

    expect(outcome.problems).toEqual([])
    expect(outcome.next.map(entry => entry.identifier)).toEqual(['shell'])
    expect(outcome.receipt).toEqual({ created: [], updated: [], removed: ['files'], renamed: [], unchanged: [] })
  })

  it('refuses to remove a group the configuration does not have', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'remove', identifier: 'shell' }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['unknown-group'])
    expect(outcome.next.map(entry => entry.identifier)).toEqual(['files'])
  })

  it('reports every problem of a batch at once instead of the first one only', () => {
    const outcome = applyGroupOps(facts(), [
      { op: 'add', identifier: 'bad id', tools: ['pwsh'] },
      { op: 'add', identifier: 'empty', tools: [] },
      { op: 'add', identifier: 'gone', tools: ['nowhere'] },
      { op: 'remove', identifier: 'files' },
    ])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['invalid-identifier', 'empty-tools', 'unknown-tool', 'unknown-group'])
    expect(outcome.problems.map(problem => problem.opIndex)).toEqual([0, 1, 2, 3])
    expect(outcome.next).toEqual([])
  })

  it('refuses a tool that two groups of one batch claim', () => {
    const outcome = applyGroupOps(facts(), [
      { op: 'add', identifier: 'files', tools: ['pwsh'] },
      { op: 'add', identifier: 'shell', tools: ['pwsh'] },
    ])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['tool-in-multiple-groups'])
    expect(outcome.problems[0]?.tool).toBe('pwsh')
  })

  it('never touches the groups it was given', () => {
    const configured = [group('files', ['pwsh'])]
    const outcome = applyGroupOps(facts({ groups: configured }), [{ op: 'add', identifier: 'shell', tools: ['web_search'] }])

    expect(outcome.problems).toEqual([])
    expect(configured).toEqual([group('files', ['pwsh'])])
    expect(configured[0]?.tools).toEqual(['pwsh'])
  })

  it('moves a tool from one group to another within one call', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [
      { op: 'remove', identifier: 'files' },
      { op: 'add', identifier: 'shell', tools: ['pwsh'] },
    ])

    expect(outcome.problems).toEqual([])
    expect(outcome.next).toEqual([{ identifier: 'shell', name: '', description: '', tools: ['pwsh'], sections: [] }])
    expect(outcome.receipt).toEqual({ created: ['shell'], updated: [], removed: ['files'], renamed: [], unchanged: [] })
  })

  it('moves a tool out of one group into another one with two updates', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh']), group('shell', ['web_search'])] }), [
      { op: 'update', identifier: 'files', tools: ['web_search'] },
      { op: 'update', identifier: 'shell', tools: ['pwsh'] },
    ])

    expect(outcome.problems).toEqual([])
    expect(outcome.next.map(entry => entry.tools)).toEqual([['web_search'], ['pwsh']])
  })

  it('keeps the groups as they were when one operation of the batch is refused', () => {
    const configured = [group('files', ['pwsh'])]
    const outcome = applyGroupOps(facts({ groups: configured }), [
      { op: 'add', identifier: 'shell', tools: ['web_search'] },
      { op: 'remove', identifier: 'nowhere' },
    ])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['unknown-group'])
    expect(outcome.next).toEqual(configured)
    expect(outcome.receipt).toEqual({ created: [], updated: [], removed: [], renamed: [], unchanged: [] })
  })

  it('reports every problem of one operation at once', () => {
    const outcome = applyGroupOps(facts({ groups: [group('files', ['pwsh'])] }), [{ op: 'update', identifier: 'files', rename: 'bad id', tools: [], description: 'x'.repeat(121) }])

    expect(outcome.problems.map(problem => problem.kind)).toEqual(['invalid-identifier', 'empty-tools', 'description-too-long'])
    expect(outcome.problems.map(problem => problem.opIndex)).toEqual([0, 0, 0])
  })
})
