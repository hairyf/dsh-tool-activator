import type { ToolGroupDraft } from './types'
import { describe, expect, it } from 'vitest'
import { groupsSavable } from './groups'

function group(overrides: Partial<ToolGroupDraft> = {}): ToolGroupDraft {
  return { identifier: 'files', name: 'Files', description: '', tools: [], sections: [], ...overrides }
}

describe('groupsSavable', () => {
  it('accepts an empty list and every identifier the schema allows', () => {
    expect(groupsSavable([])).toBe(true)
    expect(groupsSavable([group()])).toBe(true)
    expect(groupsSavable([group({ identifier: 'mcp.mail-box' })])).toBe(true)
  })

  it('rejects the empty draft a new group starts as', () => {
    expect(groupsSavable([group({ identifier: '' })])).toBe(false)
    expect(groupsSavable([group({ identifier: 'has space' })])).toBe(false)
  })

  it('rejects duplicates, which the config schema refuses as well', () => {
    expect(groupsSavable([group(), group({ name: 'Other' })])).toBe(false)
  })
})
