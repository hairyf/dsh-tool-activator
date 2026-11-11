import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolPolicy } from './shared'
import type { ActivationHistory, ActivationReceipt, ToolCatalogItem } from './types'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { activationContent } from './activation'
import { idleClockOf, planIdleRelease } from './idle'
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

function callEvent(turn: number, name: string, args: unknown, callId = `call-${turn}`): SessionEvent<'tool/call'> {
  return {
    type: 'tool/call',
    seq: SessionSeq(0),
    time: 1000,
    data: { turn, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) },
  }
}

function resultEvent(turn: number, content: ContentBlock[], callId = 'call-1'): SessionEvent<'tool/result'> {
  return {
    type: 'tool/result',
    seq: SessionSeq(1),
    time: 1001,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: {
        id: MessageId(`result:${callId}`),
        role: 'tool',
        source: { kind: 'tool', callId: ToolCallId(callId) },
        toolCallId: ToolCallId(callId),
        content,
        isError: false,
      },
    },
  }
}

function activationReceipt(callId: string, identifier: string, names: readonly string[], alreadyActive: readonly string[] = []): ActivationReceipt {
  return {
    producer: 'dsh-tool-activator',
    version: 1,
    content: 'Successfully activated tools.',
    success: true,
    state: {
      activatedTools: names.length === 0 ? [] : [{ identifier, name: identifier, apiCount: names.length, tools: [...names] }],
      activatedSkills: [],
      alreadyActive: [...alreadyActive],
      notFound: [],
    },
    authorized: true,
    approvalRequired: false,
    commit: {
      producer: 'dsh-tool-activator',
      version: 1,
      callId,
      activatedToolIds: [identifier],
      activatedSkills: [],
    },
  }
}

describe('the idle clock', () => {
  it('reads the current turn from the log and never moves it back', () => {
    const clock = idleClockOf([
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 3 } },
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(2), time: 0, data: { turn: 3, step: 1 } },
    ])

    expect(clock.currentTurn).toBe(3)
  })

  it('records the turn every tool was called on', () => {
    const clock = idleClockOf([
      callEvent(2, 'pwsh', { path: 'a' }),
      callEvent(5, 'pwsh', { path: 'b' }),
      callEvent(4, 'web_search', { query: 'c' }),
    ])

    expect(clock.calls.get('pwsh')).toBe(5)
    expect(clock.calls.get('web_search')).toBe(4)
  })

  it('records the turn an identifier was activated on, even when it was already active', () => {
    const clock = idleClockOf([
      resultEvent(1, activationContent(activationReceipt('call-1', 'files', ['pwsh'])), 'call-1'),
      resultEvent(4, activationContent(activationReceipt('call-2', 'files', [], ['files'])), 'call-2'),
    ])

    expect(clock.activations.get('files')).toBe(4)
  })

  it('does not count an activation that never took effect as a use of the entry', () => {
    const refused = [{ type: 'text' as const, text: 'Tool activation was not committed because the live scope, approval, or configuration changed.' }]
    const clock = idleClockOf([
      resultEvent(1, activationContent(activationReceipt('call-1', 'files', ['pwsh'])), 'call-1'),
      // The request is in the log, but it never committed: the entry was never
      // given to the session, so its clock does not start over.
      callEvent(3, 'activate_tools', { identifiers: ['files'], reason: 'Use the files again' }),
      resultEvent(3, refused, 'call-2'),
    ])

    expect(clock.activations.get('files')).toBe(1)
    expect(clock.activatedNames.get('pwsh')).toBe(1)
  })

  it('records the names an activation receipt carried', () => {
    const receipt = activationReceipt('call-1', 'files', ['pwsh', 'web_search'])
    const clock = idleClockOf([
      callEvent(1, 'activate_tools', { identifiers: ['files'], reason: 'Use the files' }),
      resultEvent(1, activationContent(receipt), 'call-1'),
    ])

    expect(clock.activatedNames.get('pwsh')).toBe(1)
    expect(clock.activatedNames.get('web_search')).toBe(1)
  })

  it('reads a log it has never seen before the same way twice', () => {
    const events = [
      callEvent(1, 'activate_tools', { identifiers: ['files'], reason: 'Use the files' }),
      resultEvent(1, activationContent(activationReceipt('call-1', 'files', ['pwsh'])), 'call-1'),
      callEvent(3, 'pwsh', { path: 'a' }),
    ]

    expect(idleClockOf(events)).toEqual(idleClockOf(events))
  })
})

describe('planIdleRelease', () => {
  const catalog = [entry('files', ['pwsh', 'web_search'])]
  const files = history({ activatedToolIds: ['files'], activatedToolNames: ['pwsh', 'web_search'] })

  it('reclaims an entry once the idle threshold is reached', () => {
    const clock = idleClockOf([
      callEvent(1, 'activate_tools', { identifiers: ['files'], reason: 'Use the files' }),
      resultEvent(1, activationContent(activationReceipt('call-1', 'files', ['pwsh', 'web_search'])), 'call-1'),
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 4 } },
    ])

    const result = planIdleRelease({
      catalog,
      policy: policy({ passiveRelease: { ...DEFAULT_PASSIVE_RELEASE, idleTurns: 2 } }),
      history: files,
      clock,
    })

    expect(result).toEqual([{ identifier: 'files', idleTurns: 3 }])
  })

  it('keeps an entry that is one turn short of the idle threshold', () => {
    const clock = idleClockOf([
      callEvent(1, 'activate_tools', { identifiers: ['files'], reason: 'Use the files' }),
      resultEvent(1, activationContent(activationReceipt('call-1', 'files', ['pwsh', 'web_search'])), 'call-1'),
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 3 } },
    ])

    const result = planIdleRelease({
      catalog,
      policy: policy({ passiveRelease: { ...DEFAULT_PASSIVE_RELEASE, idleTurns: 2 } }),
      history: files,
      clock,
    })

    expect(result).toEqual([])
  })

  it('refreshes the clock of an entry when one of its members is called', () => {
    const clock = idleClockOf([
      callEvent(1, 'activate_tools', { identifiers: ['files'], reason: 'Use the files' }),
      callEvent(3, 'pwsh', { path: 'a' }),
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 4 } },
    ])

    const result = planIdleRelease({
      catalog,
      policy: policy({ passiveRelease: { ...DEFAULT_PASSIVE_RELEASE, idleTurns: 2 } }),
      history: files,
      clock,
    })

    // The member ran on turn 3, so only one turn passed since the last use.
    expect(result).toEqual([])
  })

  it('counts an orphan tool name on its own', () => {
    const clock = idleClockOf([
      resultEvent(1, activationContent(activationReceipt('call-1', 'files', ['pwsh'])), 'call-1'),
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 4 } },
    ])

    const result = planIdleRelease({
      catalog,
      policy: policy({ passiveRelease: { ...DEFAULT_PASSIVE_RELEASE, idleTurns: 2 } }),
      history: history({ activatedToolNames: ['pwsh'] }),
      clock,
    })

    // The name no activated group provides is reclaimed on its own clock.
    expect(result).toEqual([{ identifier: 'pwsh', idleTurns: 3 }])
  })

  it('never reclaims what the session already released', () => {
    const clock = idleClockOf([
      callEvent(1, 'activate_tools', { identifiers: ['files'], reason: 'Use the files' }),
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 9 } },
    ])

    const result = planIdleRelease({
      catalog,
      policy: policy({ passiveRelease: { ...DEFAULT_PASSIVE_RELEASE, idleTurns: 2 } }),
      history: files,
      clock,
      released: { identifiers: new Set(['files']), names: new Set(['pwsh', 'web_search']) },
    })

    expect(result).toEqual([])
  })
})
