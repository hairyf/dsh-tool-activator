import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_POLICY } from '../shared'
import { canWriteConfiguration, createPolicyDraft, policyMutationOps, validatePolicyDraft } from './configuration'

function form(state: Partial<ConfigPageForm['state']> = {}): ConfigPageForm {
  return {
    state: { status: 'ready', value: { ...DEFAULT_POLICY }, base: undefined, user: undefined, revision: 12, writable: true, mode: 'host', ...state },
    mutate: vi.fn<ConfigPageForm['mutate']>().mockResolvedValue(true),
  }
}

describe('official configuration write gate', () => {
  it('only writes accepted, writable host snapshots with a valid revision', () => {
    expect(canWriteConfiguration(form())).toBe(true)
    expect(canWriteConfiguration(undefined)).toBe(false)
    for (const state of [
      { status: 'loading' as const },
      { status: 'unavailable' as const },
      { mode: 'memory' as const },
      { writable: false },
      { value: undefined },
      { revision: undefined },
      { revision: -1 },
      { revision: 0.5 },
      { revision: Number.NaN },
    ]) {
      expect(canWriteConfiguration(form(state))).toBe(false)
    }
    expect(canWriteConfiguration(form({ revision: 0 }))).toBe(true)
  })
})

describe('policy draft validation', () => {
  it('round trips all shared defaults and emits one atomic set operation per field', () => {
    const result = validatePolicyDraft(createPolicyDraft(undefined))
    expect(result).toEqual({ ok: true, policy: DEFAULT_POLICY })
    if (!result.ok)
      throw new Error('Expected default draft to be valid')
    const ops = policyMutationOps(result.policy)
    expect(ops).toHaveLength(8)
    expect(ops).toEqual(Object.entries(DEFAULT_POLICY).map(([key, value]) => ({ op: 'set', path: [key], value })))
  })

  it('normalizes newline lists, preserving valid names and removing duplicates', () => {
    const result = validatePolicyDraft({ ...createPolicyDraft(undefined), basicToolsText: ' read \r\ngrep\n\nread\nmcp__server__tool\n' })
    expect(result).toMatchObject({ ok: true, policy: { basicTools: ['read', 'grep', 'mcp__server__tool'] } })
  })

  it('retains explicit false flags, manual mode and empty arrays from the host', () => {
    const draft = createPolicyDraft({ enabled: false, mode: 'manual', requireApproval: false, autoGroupMcp: false, basicTools: [], excludedTools: ['pwsh'], groups: [], sectionTools: {} })
    expect(validatePolicyDraft(draft)).toMatchObject({ ok: true, policy: { enabled: false, mode: 'manual', requireApproval: false, autoGroupMcp: false, basicTools: [], excludedTools: ['pwsh'] } })
  })

  it('fills optional group strings and sections without inventing tool names', () => {
    const result = validatePolicyDraft({ ...createPolicyDraft(undefined), groupsText: '[{"identifier":"shell-tools","tools":["pwsh"]}]', sectionToolsText: '{"shell:guidance":["pwsh","pwsh"]}' })
    expect(result).toMatchObject({
      ok: true,
      policy: { groups: [{ identifier: 'shell-tools', name: '', description: '', tools: ['pwsh'], sections: [] }], sectionTools: { 'shell:guidance': ['pwsh'] } },
    })
  })

  it.each([
    ['broken JSON', '{'],
    ['non-array groups', '{}'],
    ['unknown keys', '[{"identifier":"shell","tools":["pwsh"],"typo":true}]'],
    ['invalid identifier', '[{"identifier":"shell tools","tools":["pwsh"]}]'],
    ['empty tool group', '[{"identifier":"shell","tools":[]}]'],
    ['duplicate identifier', '[{"identifier":"shell","tools":["pwsh"]},{"identifier":"shell","tools":["write"]}]'],
    ['duplicate tool across groups', '[{"identifier":"shell","tools":["pwsh"]},{"identifier":"process","tools":["pwsh"]}]'],
    ['duplicate tool within a group', '[{"identifier":"shell","tools":["pwsh","pwsh"]}]'],
    ['non-string group name', '[{"identifier":"shell","name":3,"tools":["pwsh"]}]'],
    ['non-string sections', '[{"identifier":"shell","tools":["pwsh"],"sections":[3]}]'],
  ])('rejects %s before writes', (_name, groupsText) => {
    expect(validatePolicyDraft({ ...createPolicyDraft(undefined), groupsText })).toMatchObject({ ok: false, message: expect.any(String) })
  })

  it.each(['[]', '{"section":"pwsh"}', '{"section":[3]}', '{"section":["two words"]}'])('rejects invalid section mapping %s', (sectionToolsText) => {
    expect(validatePolicyDraft({ ...createPolicyDraft(undefined), sectionToolsText })).toMatchObject({ ok: false, message: expect.any(String) })
  })

  it('preserves arbitrary section strings and safe own object keys', () => {
    const result = validatePolicyDraft({
      ...createPolicyDraft(undefined),
      groupsText: '[{"identifier":"shell","tools":["pwsh"],"sections":["","shell:tools"]}]',
      sectionToolsText: '{"":[],"__proto__":["pwsh"],"constructor":["read"]}',
    })
    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error('Expected arbitrary section names to be valid')
    expect(result.policy.groups[0]?.sections).toEqual(['', 'shell:tools'])
    expect(Object.hasOwn(result.policy.sectionTools, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result.policy.sectionTools)).toBe(Object.prototype)
  })

  it('rejects invalid line-list tool names', () => {
    expect(validatePolicyDraft({ ...createPolicyDraft(undefined), basicToolsText: 'read,grep' })).toMatchObject({ ok: false, message: expect.stringContaining('每行') })
  })
})
