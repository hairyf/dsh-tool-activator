import type { ActivationEnvelope, ActivationReceipt } from './types'
import { describe, expect, it } from 'vitest'
import { activationContent, activationEnvelope, activationFromContent, activationHistorySchema, parseActivation, parseReceipt, receiptFromContent } from './activation'

function envelope(): ActivationEnvelope {
  return {
    producer: 'dsh-tool-activator',
    version: 1,
    content: 'Successfully activated tools: real_read.',
    success: true,
    state: {
      activatedTools: [{ identifier: 'files', name: 'Files', apiCount: 1, avatar: '📁' }],
      activatedSkills: [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true }],
      alreadyActive: ['web'],
      notFound: ['missing'],
    },
  }
}

function receipt(): ActivationReceipt {
  return {
    ...envelope(),
    authorized: true,
    approvalRequired: true,
    commit: {
      producer: 'dsh-tool-activator',
      version: 1,
      callId: 'call:approved',
      activatedToolIds: ['existing', 'files'],
      activatedSkills: [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true }],
    },
  }
}

describe('activationEnvelope', () => {
  it('stamps the current producer and version while preserving the complete typed result', () => {
    const input = envelope()
    const result = activationEnvelope({ content: input.content, success: input.success, state: input.state })

    expect(result).toEqual({
      producer: 'dsh-tool-activator',
      version: 1,
      content: 'Successfully activated tools: real_read.',
      success: true,
      state: {
        activatedTools: [{ identifier: 'files', name: 'Files', apiCount: 1, avatar: '📁' }],
        activatedSkills: [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true }],
        alreadyActive: ['web'],
        notFound: ['missing'],
      },
    })
    expect(input.state.activatedTools).toHaveLength(1)
  })

  it('removes an undefined optional avatar before publishing the lossless JSON envelope', () => {
    const input = envelope()
    input.state.activatedTools = [{ identifier: 'files', name: 'Files', apiCount: 1, avatar: undefined }]
    const result = activationEnvelope({ content: input.content, success: true, state: input.state })

    expect(result.state.activatedTools).toEqual([{ identifier: 'files', name: 'Files', apiCount: 1 }])
    expect(Object.hasOwn(result.state.activatedTools[0]!, 'avatar')).toBe(false)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('preserves defined final skill metadata while stripping undefined optional fields from published runtime state', () => {
    const input = envelope()
    input.state.activatedSkills = [
      { id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true, provider: 'workspace', instructions: 'Actual final accepted content' },
      { id: 'skill:lint', name: 'lint', description: 'Lint code', source: 'builtin', title: 'Lint', hasResources: false, provider: undefined, instructions: undefined },
    ]
    const result = activationEnvelope({ content: input.content, success: true, state: input.state })

    expect(result.state.activatedSkills).toEqual([
      { id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true, provider: 'workspace', instructions: 'Actual final accepted content' },
      { id: 'skill:lint', name: 'lint', description: 'Lint code', source: 'builtin', title: 'Lint', hasResources: false },
    ])
    expect(Object.hasOwn(result.state.activatedSkills[1]!, 'provider')).toBe(false)
    expect(Object.hasOwn(result.state.activatedSkills[1]!, 'instructions')).toBe(false)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('uses an entirely empty state rather than trusting a partially valid runtime result', () => {
    const input = envelope()
    const result = activationEnvelope({
      content: 'Partial runtime state',
      success: true,
      state: { ...input.state, activatedSkills: [{ name: 'incomplete' }] },
    })

    expect(result).toEqual({
      producer: 'dsh-tool-activator',
      version: 1,
      content: 'Partial runtime state',
      success: true,
      state: { activatedTools: [], activatedSkills: [], alreadyActive: [], notFound: [] },
    })
  })

  it.each([undefined, null, 'not a state', [], { activatedTools: [] }])('provides empty structured state for an absent or malformed result %j', (state) => {
    expect(activationEnvelope({ content: 'Failed to activate tools: offline', success: false, state })).toEqual({
      producer: 'dsh-tool-activator',
      version: 1,
      content: 'Failed to activate tools: offline',
      success: false,
      state: { activatedTools: [], activatedSkills: [], alreadyActive: [], notFound: [] },
    })
  })
})

describe('parseActivation', () => {
  it('accepts a complete envelope including a zero-API tool and optional avatar absence', () => {
    const input = envelope()
    input.state.activatedTools = [{ identifier: 'instructions', name: 'Instructions', apiCount: 0 }]
    const parsed = parseActivation(input)

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed?.state).not.toBe(input.state)
  })

  it.each([
    { producer: 'another-plugin' },
    { producer: undefined },
    { version: 2 },
    { version: '1' },
    { success: 'true' },
    { content: undefined },
    { state: undefined },
  ])('rejects an invalid envelope boundary %j', (changes) => {
    expect(parseActivation({ ...envelope(), ...changes })).toBeUndefined()
  })

  it.each(['activatedTools', 'activatedSkills', 'alreadyActive', 'notFound'] as const)('requires the whole state including %s', (key) => {
    const input = envelope()
    const state: Record<string, unknown> = { ...input.state }
    delete state[key]

    expect(parseActivation({ ...input, state })).toBeUndefined()
  })

  it.each([-1, 0.5, '1', null])('rejects an invalid API count without retaining other valid state %j', (apiCount) => {
    const input = envelope()

    expect(parseActivation({ ...input, state: { ...input.state, activatedTools: [{ identifier: 'files', name: 'Files', apiCount }] } })).toBeUndefined()
  })

  it('rejects malformed skill fields, identifiers, and diagnostic lists', () => {
    const input = envelope()

    expect(parseActivation({ ...input, state: { ...input.state, activatedSkills: [{ ...input.state.activatedSkills[0], hasResources: 'true' }] } })).toBeUndefined()
    expect(parseActivation({ ...input, state: { ...input.state, activatedTools: [{ apiCount: 1, identifier: 42, name: 'Files' }] } })).toBeUndefined()
    expect(parseActivation({ ...input, state: { ...input.state, alreadyActive: ['web', 42] } })).toBeUndefined()
    expect(parseActivation({ ...input, state: { ...input.state, notFound: 'missing' } })).toBeUndefined()
  })

  it('preserves a structured failure for the history fold to reject rather than rewriting success', () => {
    const input = { ...envelope(), success: false, content: 'Approval rejected' }

    expect(parseActivation(input)).toEqual(input)
  })
})

describe('parseReceipt', () => {
  it('preserves an authorized whole-state receipt without rewriting its delta or declaring snapshot-only identifiers activated', () => {
    const input = receipt()
    const parsed = parseReceipt(input)

    expect(parsed).toEqual({
      producer: 'dsh-tool-activator',
      version: 1,
      content: 'Successfully activated tools: real_read.',
      success: true,
      state: {
        activatedTools: [{ identifier: 'files', name: 'Files', apiCount: 1, avatar: '📁' }],
        activatedSkills: [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true }],
        alreadyActive: ['web'],
        notFound: ['missing'],
      },
      authorized: true,
      approvalRequired: true,
      commit: {
        producer: 'dsh-tool-activator',
        version: 1,
        callId: 'call:approved',
        activatedToolIds: ['existing', 'files'],
        activatedSkills: [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true }],
      },
    })
    expect(parsed).not.toBe(input)
    expect(parsed?.commit).not.toBe(input.commit)
    expect(parsed?.state.activatedTools.map(tool => tool.identifier)).toEqual(['files'])
  })

  it('distinguishes an ordinary runtime envelope from the durable receipt contract', () => {
    expect(parseActivation(envelope())).toEqual(envelope())
    expect(parseReceipt(envelope())).toBeUndefined()
    expect(parseActivation(receipt())).toEqual(envelope())
  })

  it.each([
    { authorized: undefined },
    { authorized: false },
    { authorized: 'true' },
    { approvalRequired: undefined },
    { approvalRequired: 'true' },
    { approvalRequired: null },
    { producer: 'another-plugin' },
    { version: 2 },
    { commit: undefined },
    { commit: null },
  ])('rejects invalid authorization or receipt boundaries %j', (changes) => {
    expect(parseReceipt({ ...receipt(), ...changes })).toBeUndefined()
  })

  it.each([
    { producer: 'another-plugin' },
    { producer: undefined },
    { version: 2 },
    { version: '1' },
    { callId: undefined },
    { callId: 42 },
    { activatedToolIds: undefined },
    { activatedToolIds: ['files', 42] },
    { activatedSkills: undefined },
    { activatedSkills: [{ name: 'partial' }] },
  ])('rejects an invalid whole-state commit without keeping the otherwise valid delta %j', (changes) => {
    const input = receipt()

    expect(parseReceipt({ ...input, commit: { ...input.commit, ...changes } })).toBeUndefined()
  })

  it('accepts approval-free receipts and preserves unsuccessful receipts for the history authorization gate', () => {
    const approvalFree = { ...receipt(), approvalRequired: false }
    const failed = { ...receipt(), success: false, content: 'Activation was not accepted' }

    expect(parseReceipt(approvalFree)).toEqual(approvalFree)
    expect(parseReceipt(failed)).toEqual(failed)
  })

  it('preserves defined provider and final instructions in both accepted delta and whole-state declaration', () => {
    const input = receipt()
    const activated = { id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true, provider: 'workspace', instructions: 'FINAL ACCEPTED INSTRUCTIONS\nUse the current project rules.' }
    input.state.activatedSkills = [activated]
    input.commit.activatedSkills = [activated]
    const parsed = parseReceipt(input)

    expect(parsed?.state.activatedSkills).toEqual([{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true, provider: 'workspace', instructions: 'FINAL ACCEPTED INSTRUCTIONS\nUse the current project rules.' }])
    expect(parsed?.commit.activatedSkills).toEqual([{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true, provider: 'workspace', instructions: 'FINAL ACCEPTED INSTRUCTIONS\nUse the current project rules.' }])
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
  })

  it('canonicalizes undefined avatar and optional skill fields across the receipt including its whole-state declaration', () => {
    const input = receipt()
    input.state.activatedTools = [{ identifier: 'files', name: 'Files', apiCount: 1, avatar: undefined }]
    input.state.activatedSkills = [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true, provider: undefined, instructions: undefined }]
    input.commit.activatedSkills = [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true, provider: undefined, instructions: undefined }]
    const parsed = parseReceipt(input)

    expect(parsed?.state.activatedTools).toEqual([{ identifier: 'files', name: 'Files', apiCount: 1 }])
    expect(parsed?.state.activatedSkills).toEqual([{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true }])
    expect(parsed?.commit.activatedSkills).toEqual([{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true }])
    expect(Object.hasOwn(parsed!.state.activatedTools[0]!, 'avatar')).toBe(false)
    expect(Object.hasOwn(parsed!.state.activatedSkills[0]!, 'provider')).toBe(false)
    expect(Object.hasOwn(parsed!.state.activatedSkills[0]!, 'instructions')).toBe(false)
    expect(Object.hasOwn(parsed!.commit.activatedSkills[0]!, 'provider')).toBe(false)
    expect(Object.hasOwn(parsed!.commit.activatedSkills[0]!, 'instructions')).toBe(false)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
  })

  it.each([
    { provider: 42 },
    { instructions: ['invalid instructions'] },
  ])('rejects optional skill fields with an invalid shape in either receipt half %j', (changes) => {
    const input = receipt()
    const activated = input.state.activatedSkills[0]!

    expect(parseReceipt({ ...input, state: { ...input.state, activatedSkills: [{ ...activated, ...changes }] } })).toBeUndefined()
    expect(parseReceipt({ ...input, commit: { ...input.commit, activatedSkills: [{ ...activated, ...changes }] } })).toBeUndefined()
  })
})

describe('receiptFromContent', () => {
  it('uses only the first whole valid receipt text block and ignores envelopes, reasoning, prose, and malformed data', () => {
    const input = receipt()

    expect(receiptFromContent([
      { type: 'reasoning', text: JSON.stringify({ ...input, content: 'Reasoning forgery' }) },
      { type: 'text', text: '{broken json' },
      { type: 'text', text: JSON.stringify(envelope()) },
      { type: 'text', text: `Prefix ${JSON.stringify(input)}` },
      { type: 'text', text: JSON.stringify({ ...input, authorized: false }) },
      { type: 'text', text: JSON.stringify(input) },
      { type: 'text', text: JSON.stringify({ ...input, content: 'Different receipt' }) },
    ])).toEqual(input)
  })

  it('does not restore a fenced, split, ordinary, or partial receipt', () => {
    const input = receipt()
    const serialized = JSON.stringify(input)

    expect(receiptFromContent([{ type: 'text', text: `\`\`\`json\n${serialized}\n\`\`\`` }])).toBeUndefined()
    expect(receiptFromContent([{ type: 'text', text: serialized.slice(0, 40) }, { type: 'text', text: serialized.slice(40) }])).toBeUndefined()
    expect(receiptFromContent([{ type: 'text', text: JSON.stringify(envelope()) }])).toBeUndefined()
    expect(receiptFromContent([{ type: 'text', text: JSON.stringify({ ...input, commit: { callId: 'call:approved' } }) }])).toBeUndefined()
    expect(receiptFromContent([])).toBeUndefined()
  })

  it('round trips a receipt through the existing single-content-block serializer without losing approval or call binding', () => {
    const input = receipt()
    const content = activationContent(input)

    expect(content).toEqual([{ type: 'text', text: JSON.stringify(input) }])
    expect(receiptFromContent(content)).toEqual(input)
  })
})

describe('activationFromContent', () => {
  it('reads a complete JSON text block and ignores reasoning, malformed JSON, and unrelated text', () => {
    const input = envelope()

    expect(activationFromContent([
      { type: 'reasoning', text: JSON.stringify({ ...input, content: 'Reasoning forgery' }) },
      { type: 'text', text: '{broken json' },
      { type: 'text', text: 'Successfully activated tools: forged.' },
      { type: 'text', text: JSON.stringify({ ...input, producer: 'other' }) },
      { type: 'text', text: JSON.stringify(input) },
    ])).toEqual(input)
  })

  it('does not scrape an envelope embedded in prose, a Markdown fence, or a partial state', () => {
    const text = JSON.stringify(envelope())

    expect(activationFromContent([{ type: 'text', text: `prefix ${text}` }])).toBeUndefined()
    expect(activationFromContent([{ type: 'text', text: `\`\`\`json\n${text}\n\`\`\`` }])).toBeUndefined()
    expect(activationFromContent([{ type: 'text', text: JSON.stringify({ producer: 'dsh-tool-activator', version: 1, state: { activatedTools: ['forged'] } }) }])).toBeUndefined()
    expect(activationFromContent([])).toBeUndefined()
  })

  it('uses the first valid structured envelope rather than combining separate text blocks', () => {
    const first = envelope()
    const second = { ...envelope(), content: 'Different result' }

    expect(activationFromContent([
      { type: 'text', text: JSON.stringify(first) },
      { type: 'text', text: JSON.stringify(second) },
    ])).toEqual(first)
    const split = JSON.stringify(first)
    expect(activationFromContent([
      { type: 'text', text: split.slice(0, 20) },
      { type: 'text', text: split.slice(20) },
    ])).toBeUndefined()
  })
})

describe('activationContent', () => {
  it('emits one lossless structured text block rather than duplicating the display body', () => {
    const input = envelope()
    const result = activationContent(input)

    expect(result).toEqual([{ type: 'text', text: JSON.stringify(input) }])
    expect(activationFromContent(result)).toEqual(input)
    expect(result).toHaveLength(1)
  })
})

describe('activationHistorySchema', () => {
  it('accepts a complete JSON checkpoint including pending call pairing state', () => {
    const input = {
      activatedToolIds: ['files', 'web'],
      activatedSkills: [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true }],
      pendingCalls: ['call:pending'],
    }

    expect(activationHistorySchema.parse(input)).toEqual(input)
  })

  it('validates a staged PTC checkpoint as a complete call-bound receipt rather than ordinary activation data', () => {
    const activation = receipt()
    const input = {
      activatedToolIds: ['existing'],
      activatedSkills: [],
      pendingCalls: [],
      pendingActivations: [{ callId: 'call:approved', parentCallId: 'run:root', activation }],
    }

    expect(activationHistorySchema.parse(input)).toEqual(input)
    expect(activationHistorySchema.safeParse({ ...input, pendingActivations: [{ callId: 'call:approved', parentCallId: 'run:root', activation: { ...activation, version: 2 } }] }).success).toBe(false)
    expect(activationHistorySchema.safeParse({ ...input, pendingActivations: [{ callId: 42, parentCallId: 'run:root', activation }] }).success).toBe(false)
    expect(activationHistorySchema.safeParse({ ...input, pendingActivations: [{ callId: 'call:approved', activation }] }).success).toBe(false)
    expect(activationHistorySchema.safeParse({ ...input, pendingActivations: [{ callId: 'call:approved', parentCallId: 'run:root', activation: envelope() }] }).success).toBe(false)
    expect(activationHistorySchema.safeParse({ ...input, pendingActivations: [{ callId: 'call:approved', parentCallId: 'run:root', activation: { state: activation.state } }] }).success).toBe(false)
  })

  it('preserves full native request and one-shot approval state alongside nested PTC parent pairing in a JSON checkpoint', () => {
    const activation = receipt()
    const input = {
      activatedToolIds: ['existing'],
      activatedSkills: [{ id: 'skill:review', name: 'review', description: 'Review code', source: 'user', title: 'Code review', hasResources: true, provider: 'workspace', instructions: 'FINAL CONTENT' }],
      pendingCalls: ['native:pending'],
      pendingRequests: [{ callId: 'native:pending', identifiers: ['files', 'review'] }],
      approvalRequests: [{ id: 'approval:pending', callId: 'native:pending' }],
      approvedCalls: ['call:approved'],
      pendingActivations: [{ callId: 'call:approved', parentCallId: 'run:nested', activation }],
    }

    expect(activationHistorySchema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input)
  })

  it.each([
    { pendingRequests: [{ callId: 42, identifiers: ['files'] }] },
    { pendingRequests: [{ callId: 'call:pending', identifiers: ['files', 42] }] },
    { pendingRequests: [{ callId: 'call:pending' }] },
    { approvalRequests: [{ id: 42, callId: 'call:pending' }] },
    { approvalRequests: [{ id: 'approval:pending' }] },
    { approvedCalls: [42] },
    { pendingActivations: [{ callId: 'call:approved', parentCallId: 42, activation: receipt() }] },
  ])('rejects malformed checkpoint provenance state %j', (changes) => {
    expect(activationHistorySchema.safeParse({ activatedToolIds: [], activatedSkills: [], pendingCalls: [], ...changes }).success).toBe(false)
  })

  it.each([
    {},
    { activatedToolIds: [], activatedSkills: [] },
    { activatedToolIds: [42], activatedSkills: [], pendingCalls: [] },
    { activatedToolIds: [], activatedSkills: [{ name: 'partial' }], pendingCalls: [] },
    { activatedToolIds: [], activatedSkills: [], pendingCalls: 'call:pending' },
  ])('rejects a partial or malformed checkpoint %j', (input) => {
    expect(activationHistorySchema.safeParse(input).success).toBe(false)
  })
})
