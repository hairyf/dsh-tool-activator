import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolPolicy } from './shared'
import type { ActivationHistory, ToolCatalogItem } from './types'
import { describe, expect, it } from 'vitest'
import { planRelease, releaseContent, releasedOf, releaseReceipt, releaseReceiptFromContent } from './release'
import { DEFAULT_PASSIVE_RELEASE } from './shared'

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    basicTools: ['read'],
    requireApproval: true,
    autoGroupMcp: true,
    passiveRelease: { ...DEFAULT_PASSIVE_RELEASE },
    groups: [],
    sectionTools: {},
    ...overrides,
  }
}

function tool(name: string): ToolSchema {
  return { name, description: `${name} description`, parameters: { type: 'object', properties: {} } }
}

function entry(identifier: string, names: readonly string[]): ToolCatalogItem {
  const tools = names.map(tool)
  return {
    identifier,
    name: identifier,
    description: '',
    apiDescriptions: tools.map(item => ({ name: item.name, description: item.description })),
    tools,
    sections: [],
  }
}

function history(overrides: Partial<ActivationHistory> = {}): ActivationHistory {
  return { activatedToolIds: [], activatedToolNames: [], activatedSkills: [], pendingCalls: [], ...overrides }
}

const catalog = [entry('files', ['pwsh', 'web_search'])]

describe('planRelease', () => {
  it('releases an entry by its identifier and takes its members with it', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolIds: ['files'], activatedToolNames: ['pwsh', 'web_search'] }),
    }, ['files'])

    expect(plan).toEqual({
      released: [{ identifier: 'files', names: ['pwsh', 'web_search'] }],
      refused: [],
      notFound: [],
      alreadyReleased: [],
    })
  })

  it('releases a bare tool name no activated group provides', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolNames: ['web_search'] }),
    }, ['web_search'])

    expect(plan.released).toEqual([{ identifier: 'web_search', names: ['web_search'] }])
    expect(plan.refused).toEqual([])
  })

  it('refuses a bare name an activated group provides and names the group instead', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolIds: ['files'], activatedToolNames: ['pwsh', 'web_search'] }),
    }, ['pwsh'])

    expect(plan.released).toEqual([])
    expect(plan.refused).toEqual([
      { identifier: 'pwsh', reason: 'Tool pwsh is provided by the activated group files; release the group identifier files instead.' },
    ])
  })

  it('refuses the basic tools and the locked tools', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolNames: ['read', 'activate_tools'] }),
    }, ['read', 'activate_tools'])

    expect(plan.released).toEqual([])
    expect(plan.refused.map(refusal => refusal.identifier)).toEqual(['read', 'activate_tools'])
    expect(plan.refused[0]?.reason).toContain('is a basic tool')
    expect(plan.refused[1]?.reason).toContain('is locked')
  })

  it('answers an identifier the scope does not know with notFound', () => {
    const plan = planRelease({ catalog, policy: policy(), history: history() }, ['missing'])

    expect(plan.notFound).toEqual(['missing'])
    expect(plan.released).toEqual([])
    expect(plan.refused).toEqual([])
  })

  it('is idempotent for an entry the session never activated', () => {
    const plan = planRelease({ catalog, policy: policy(), history: history() }, ['files'])

    expect(plan.alreadyReleased).toEqual(['files'])
    expect(plan.released).toEqual([])
  })

  it('never releases what the session already released', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolIds: ['files'], activatedToolNames: ['pwsh', 'web_search'] }),
      released: { identifiers: new Set(['files']), names: new Set(['pwsh', 'web_search']) },
    }, ['files'])

    expect(plan.alreadyReleased).toEqual(['files'])
    expect(plan.released).toEqual([])
  })

  it('asks for every identifier only once', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolIds: ['files'], activatedToolNames: ['pwsh', 'web_search'] }),
    }, ['files', 'files'])

    expect(plan.released).toHaveLength(1)
  })
})

describe('releaseReceipt', () => {
  it('answers a partial success with what it released and what it did not', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolIds: ['files'], activatedToolNames: ['pwsh', 'web_search'] }),
    }, ['files', 'missing'])

    expect(releaseReceipt(plan)).toEqual({
      success: true,
      released: { identifiers: ['files'], toolNames: ['pwsh', 'web_search'] },
      refused: [],
      notFound: ['missing'],
      alreadyReleased: [],
    })
  })

  it('answers a refusal with a failure', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolIds: ['files'], activatedToolNames: ['pwsh', 'web_search'] }),
    }, ['pwsh'])

    const receipt = releaseReceipt(plan)

    expect(receipt.success).toBe(false)
    expect(receipt.released).toEqual({ identifiers: [], toolNames: [] })
    expect(receipt.refused).toHaveLength(1)
  })

  it('keeps a retry that changes nothing a success', () => {
    const plan = planRelease({ catalog, policy: policy(), history: history() }, ['files'])

    expect(releaseReceipt(plan)).toEqual({
      success: true,
      released: { identifiers: [], toolNames: [] },
      refused: [],
      notFound: [],
      alreadyReleased: ['files'],
    })
  })

  it('answers a call that named nothing with a failure', () => {
    expect(releaseReceipt({ released: [], refused: [], notFound: [], alreadyReleased: [] }).success).toBe(false)
  })

  it('survives the round trip through a tool result', () => {
    const plan = planRelease({
      catalog,
      policy: policy(),
      history: history({ activatedToolIds: ['files'], activatedToolNames: ['pwsh', 'web_search'] }),
    }, ['files'])
    const receipt = releaseReceipt(plan)

    expect(releaseReceiptFromContent(releaseContent(receipt))).toEqual(receipt)
  })
})

describe('releasedOf', () => {
  it('reads the release records of this plugin\'s own catalog message', () => {
    const released = [{ identifier: 'files', names: ['read'], reason: { kind: 'active' as const, text: 'The files are not needed any more' } }]

    expect(releasedOf({ kind: 'tool-activator', form: 'catalog', entries: [], released })).toEqual(released)
  })

  it('reads nothing from a message of another plugin or of another form', () => {
    expect(releasedOf({ kind: 'other-plugin', form: 'catalog', released: [] })).toEqual([])
    expect(releasedOf({ kind: 'tool-activator', form: 'other', released: [] })).toEqual([])
    expect(releasedOf(undefined)).toEqual([])
    expect(releasedOf({ kind: 'tool-activator', form: 'catalog', released: 'nonsense' })).toEqual([])
  })
})
