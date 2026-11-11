import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { } from '@deepseek-ai/dsh-tools'
import type { } from '@deepseek-ai/dsh-user-approval'
import type { ActivationEnvelope, ActivationHistory, ActivationReceipt } from './types'
import { z } from 'zod'
import { receiptFromContent, requestedIdentifiers } from './activation'
import { ACTIVATOR_TOOL_NAME, DEACTIVATOR_TOOL_NAME, GROUPING_TOOL_NAME } from './constants'
import { releasedOf, releaseReceiptFromContent } from './release'

/**
 * The shape of a grouping result that may carry the names a rename or a removal
 * would drop from the activation account. Anything else is not a grouping result
 * and carries no names.
 */
const groupingResultSchema = z.object({
  action: z.enum(['list', 'apply']),
  migrated: z.array(z.string()).optional(),
})

export function emptyActivationHistory(): ActivationHistory {
  return { activatedToolIds: [], activatedSkills: [], pendingCalls: [] }
}

export function mergeActivation(state: ActivationHistory, result: ActivationEnvelope): ActivationHistory {
  if (!result.success)
    return state
  const identifiers = new Set(state.activatedToolIds)
  const names = new Set(state.activatedToolNames ?? [])
  for (const tool of result.state.activatedTools) {
    identifiers.add(tool.identifier)
    // The names are folded next to the identifiers because they are what survives
    // a renamed or split group; the identifiers alone would die with the group.
    for (const name of tool.tools ?? [])
      names.add(name)
  }
  const skills = new Map(state.activatedSkills.map(skill => [skill.id, skill]))
  for (const skill of result.state.activatedSkills) {
    skills.delete(skill.id)
    skills.set(skill.id, skill)
  }
  if (identifiers.size === state.activatedToolIds.length
    && names.size === (state.activatedToolNames?.length ?? 0)
    && result.state.activatedSkills.length === 0) {
    return state
  }
  return {
    ...state,
    activatedToolIds: [...identifiers],
    ...(names.size > 0 ? { activatedToolNames: [...names] } : {}),
    activatedSkills: [...skills.values()],
  }
}

/**
 * Apply a release to the session's activation account.
 *
 * The fold only subtracts: a release takes the identifiers and the names out
 * of the account, and it never decides what should have been released. The
 * subtraction is idempotent, so a record that arrives twice changes nothing
 * the second time.
 */
export function mergeRelease(state: ActivationHistory, release: { identifiers: readonly string[], names: readonly string[] }): ActivationHistory {
  const identifiers = new Set(release.identifiers)
  const names = new Set(release.names)
  const activatedToolIds = state.activatedToolIds.filter(id => !identifiers.has(id))
  const activatedToolNames = (state.activatedToolNames ?? []).filter(name => !names.has(name))
  if (activatedToolIds.length === state.activatedToolIds.length
    && activatedToolNames.length === (state.activatedToolNames?.length ?? 0)) {
    return state
  }
  return {
    ...state,
    activatedToolIds,
    ...(state.activatedToolNames === undefined ? {} : { activatedToolNames }),
  }
}

/**
 * The tool names a grouping result carried over into the session account. The
 * result is the only place that knows which members a renamed or removed group
 * carried, so the names travel with it and are folded in here.
 */
function migratedFromContent(content: readonly ContentBlock[]): string[] {
  for (const block of content) {
    if (block.type !== 'text')
      continue
    try {
      const parsed = groupingResultSchema.safeParse(JSON.parse(block.text))
      if (parsed.success && parsed.data.migrated)
        return parsed.data.migrated
    }
    catch { }
  }
  return []
}

function validReceipt(state: ActivationHistory, receipt: ActivationReceipt, callId: string, identifiers: readonly string[]): boolean {
  return receipt.success
    && receipt.commit.callId === callId
    && (!receipt.approvalRequired || (state.approvedCalls ?? []).includes(callId))
    && receipt.state.activatedTools.every(tool => identifiers.includes(tool.identifier) && receipt.commit.activatedToolIds.includes(tool.identifier))
    && receipt.state.activatedSkills.every(skill => identifiers.includes(skill.name) && receipt.commit.activatedSkills.some(item => item.id === skill.id && item.name === skill.name))
}

/**
 * Fold one session event into the activation account.
 *
 * The fold only applies what the events describe. The reserved `skillReleases`
 * field travels along untouched: decision 13 keeps skill releases out of v1, so
 * no event writes that field and none of them reads it.
 */
export function foldActivationEvent(state: ActivationHistory, event: SessionEvent): ActivationHistory {
  if (event.type === 'tool/call' && event.data.name === ACTIVATOR_TOOL_NAME) {
    const identifiers = requestedIdentifiers(event.data.arguments)
    if (!identifiers)
      return state
    return {
      ...state,
      pendingCalls: [...new Set([...state.pendingCalls, event.data.callId])],
      pendingRequests: [...(state.pendingRequests ?? []).filter(item => item.callId !== event.data.callId), { callId: event.data.callId, identifiers }],
    }
  }

  if (event.type === 'tool/call' && event.data.name === DEACTIVATOR_TOOL_NAME) {
    // A release result carries no tool name of its own, so the call is the only
    // thing that tells it apart from any other tool result.
    return {
      ...state,
      pendingDeactivateCalls: [...new Set([...(state.pendingDeactivateCalls ?? []), event.data.callId])],
    }
  }

  if (event.type === 'tool/call' && event.data.name === GROUPING_TOOL_NAME) {
    // A grouping result carries no tool name of its own, so the call is the only
    // thing that tells the result apart from any other tool result.
    return {
      ...state,
      pendingGroupingCalls: [...new Set([...(state.pendingGroupingCalls ?? []), event.data.callId])],
    }
  }

  if (event.type === 'user/message') {
    // The catalog message carries the release records of this session: the
    // fold applies them and never recomputes what should have been released.
    const released = releasedOf(event.data.source)
    if (released.length === 0)
      return state
    return mergeRelease(state, {
      identifiers: released.map(entry => entry.identifier),
      names: released.flatMap(entry => entry.names),
    })
  }

  if (event.type === 'approval/asked' && event.data.toolName === ACTIVATOR_TOOL_NAME && event.data.callId) {
    return {
      ...state,
      approvalRequests: [...(state.approvalRequests ?? []), { id: event.data.id, callId: event.data.callId }],
    }
  }

  if (event.type === 'approval/decided') {
    const request = (state.approvalRequests ?? []).find(item => item.id === event.data.id)
    if (!request)
      return state
    const approved = new Set(state.approvedCalls ?? [])
    if (event.data.outcome === 'allowed-once')
      approved.add(request.callId)
    else
      approved.delete(request.callId)
    return {
      ...state,
      approvalRequests: (state.approvalRequests ?? []).filter(item => item.id !== event.data.id),
      approvedCalls: [...approved],
    }
  }

  if (event.type === 'tool/result') {
    const { message } = event.data
    const pending = (state.pendingActivations ?? []).filter(item => item.parentCallId === message.toolCallId)
    const request = (state.pendingRequests ?? []).find(item => item.callId === message.toolCallId)
    const grouping = (state.pendingGroupingCalls ?? []).includes(message.toolCallId)
    const deactivating = (state.pendingDeactivateCalls ?? []).includes(message.toolCallId)
    if (!request && pending.length === 0 && !grouping && !deactivating)
      return state
    let next: ActivationHistory = {
      ...state,
      pendingCalls: state.pendingCalls.filter(id => id !== message.toolCallId),
      ...(state.pendingRequests ? { pendingRequests: state.pendingRequests.filter(item => item.callId !== message.toolCallId) } : {}),
      ...(state.pendingActivations ? { pendingActivations: state.pendingActivations.filter(item => item.parentCallId !== message.toolCallId) } : {}),
      ...(state.approvedCalls ? { approvedCalls: state.approvedCalls.filter(id => id !== message.toolCallId) } : {}),
      ...(state.pendingGroupingCalls ? { pendingGroupingCalls: state.pendingGroupingCalls.filter(id => id !== message.toolCallId) } : {}),
      ...(state.pendingDeactivateCalls ? { pendingDeactivateCalls: state.pendingDeactivateCalls.filter(id => id !== message.toolCallId) } : {}),
    }
    if (message.isError)
      return next
    for (const item of pending)
      next = mergeActivation(next, item.activation)
    if (request) {
      const receipt = receiptFromContent(message.content)
      if (receipt && validReceipt(state, receipt, message.toolCallId, request.identifiers))
        next = mergeActivation(next, receipt)
    }
    if (deactivating) {
      // The release the tool result carries is the same record the catalog
      // message publishes; applying it here keeps the release durable even when
      // the session ends before the next step publishes the catalog.
      const receipt = releaseReceiptFromContent(message.content)
      if (receipt) {
        next = mergeRelease(next, {
          identifiers: receipt.released.identifiers,
          names: receipt.released.toolNames,
        })
      }
    }
    if (grouping) {
      // The names of the members a renamed or removed group carried join the
      // account of the session: they are what keeps those tools callable.
      const migrated = migratedFromContent(message.content)
      if (migrated.length > 0) {
        const names = new Set(next.activatedToolNames ?? [])
        for (const name of migrated)
          names.add(name)
        next = { ...next, activatedToolNames: [...names] }
      }
    }
    return next
  }

  if (event.type === 'tool/ptc-dispatch') {
    const pending = (state.pendingActivations ?? []).filter(item => item.parentCallId === event.data.subCallId)
    const remaining = (state.pendingActivations ?? []).filter(item => item.parentCallId !== event.data.subCallId)
    if (event.data.isError)
      return pending.length === 0 ? state : { ...state, pendingActivations: remaining }
    const staged = pending.map(item => ({ ...item, parentCallId: event.data.parentCallId }))
    if (event.data.name === ACTIVATOR_TOOL_NAME) {
      const receipt = receiptFromContent(event.data.content)
      const identifiers = requestedIdentifiers(event.data.arguments)
      if (receipt && identifiers && validReceipt(state, receipt, event.data.subCallId, identifiers))
        staged.push({ callId: event.data.subCallId, parentCallId: event.data.parentCallId, activation: receipt })
    }
    return staged.length === 0 ? state : { ...state, pendingActivations: [...remaining, ...staged] }
  }

  if (event.type === 'turn/end') {
    const hasPending = state.pendingCalls.length > 0
      || (state.pendingRequests?.length ?? 0) > 0
      || (state.pendingActivations?.length ?? 0) > 0
      || (state.approvalRequests?.length ?? 0) > 0
      || (state.approvedCalls?.length ?? 0) > 0
      || (state.pendingGroupingCalls?.length ?? 0) > 0
      || (state.pendingDeactivateCalls?.length ?? 0) > 0
    if (hasPending) {
      return {
        ...state,
        pendingCalls: [],
        ...(state.pendingRequests ? { pendingRequests: [] } : {}),
        ...(state.pendingActivations ? { pendingActivations: [] } : {}),
        ...(state.approvalRequests ? { approvalRequests: [] } : {}),
        ...(state.approvedCalls ? { approvedCalls: [] } : {}),
        ...(state.pendingGroupingCalls ? { pendingGroupingCalls: [] } : {}),
        ...(state.pendingDeactivateCalls ? { pendingDeactivateCalls: [] } : {}),
      }
    }
  }
  return state
}
