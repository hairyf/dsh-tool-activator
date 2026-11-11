import type { ToolGroupDraft } from './types'
import { describe, expect, it } from 'vitest'
import { groupChoices, groupsSavable, missingMembers, toolClaimable } from './groups'

function group(overrides: Partial<ToolGroupDraft> = {}): ToolGroupDraft {
  return { identifier: 'files', name: 'Files', description: '', tools: [], sections: [], ...overrides }
}

describe('groupsSavable', () => {
  it('accepts an empty list and a finished group', () => {
    expect(groupsSavable([])).toBe(true)
    expect(groupsSavable([group({ tools: ['read'] })])).toBe(true)
    expect(groupsSavable([group({ identifier: 'mcp.mail-box', tools: ['mcp__mail__send'] })])).toBe(true)
  })

  it('rejects the empty draft a new group starts as', () => {
    expect(groupsSavable([group({ identifier: '', tools: ['read'] })])).toBe(false)
    expect(groupsSavable([group({ identifier: 'has space', tools: ['read'] })])).toBe(false)
  })

  it('rejects duplicates, which the config schema refuses as well', () => {
    expect(groupsSavable([group({ tools: ['read'] }), group({ name: 'Other', tools: ['write'] })])).toBe(false)
  })

  // validatePolicy refuses both of these, so the page must not write them at all:
  // otherwise one bad draft bounces off the Host and rolls the whole page back.
  it('rejects a group without tools', () => {
    expect(groupsSavable([group()])).toBe(false)
    expect(groupsSavable([group({ tools: ['read'] }), group({ identifier: 'audio', tools: [] })])).toBe(false)
  })

  it('rejects a tool claimed by two groups', () => {
    expect(groupsSavable([group({ tools: ['read'] }), group({ identifier: 'audio', tools: ['read'] })])).toBe(false)
  })

  it('rejects a tool name the schema would refuse', () => {
    expect(groupsSavable([group({ tools: ['has space'] })])).toBe(false)
  })
})

describe('groupChoices', () => {
  const NAMES = ['read', 'write', 'pwsh']
  const groups = [group({ tools: ['write'] }), group({ identifier: 'audio', tools: ['pwsh'] })]

  it('lists the group members first, then the free tools', () => {
    expect(groupChoices(NAMES, [], [group({ tools: ['write'] })], 0, [])).toEqual(['write', 'read', 'pwsh'])
  })

  it('hides the locked tools, the default-loaded ones and the other groups ones', () => {
    expect(groupChoices(NAMES, ['read'], groups, 0, ['activate_tools'])).toEqual(['write'])
    expect(groupChoices(NAMES, ['read'], groups, 1, ['activate_tools'])).toEqual(['pwsh'])
  })

  it('keeps a legacy member another owner also holds, so it can still go', () => {
    const shared = [group({ tools: ['read', 'write'] }), group({ identifier: 'audio', tools: ['read'] })]

    expect(groupChoices(NAMES, ['read'], shared, 0, [])).toEqual(['read', 'write', 'pwsh'])
  })

  it('never lists a locked tool, not even when every other tool is free', () => {
    expect(groupChoices(['activate_tools', 'read'], [], [], 0, ['activate_tools'])).toEqual(['read'])
  })
})

describe('toolClaimable', () => {
  it('refuses a locked tool and the default-loaded ones', () => {
    expect(toolClaimable('activate_tools', [], [], 0, ['activate_tools'])).toBe(false)
    expect(toolClaimable('read', ['read'], [], 0, [])).toBe(false)
    expect(toolClaimable('read', ['write'], [], 0, [])).toBe(true)
  })

  it('refuses a tool another group already owns, but not its own', () => {
    const owned = [group({ tools: ['read'] })]

    expect(toolClaimable('read', [], owned, 0, [])).toBe(true)
    expect(toolClaimable('read', [], owned, 1, [])).toBe(false)
  })
})

describe('missingMembers', () => {
  it('keeps the configured order and only reports the uninstalled ones', () => {
    expect(missingMembers(['read', 'gone', 'write'], ['gone', 'elsewhere'])).toEqual(['gone'])
  })

  it('reports nothing without a missing list', () => {
    expect(missingMembers(['read'], [])).toEqual([])
  })
})
