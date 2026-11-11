import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ActivationEnvelope, ActivationHistory, ActivationReceipt } from './types'
import { z } from 'zod'
import { receiptFromContent } from './activation'
import { ACTIVATOR_TOOL_NAME } from './constants'

const requestSchema = z.object({ identifiers: z.array(z.string()), reason: z.string() })

export function emptyActivationHistory(): ActivationHistory {
  return { activatedToolIds: [], activatedSkills: [], pendingCalls: [] }
}

export function mergeActivation(state: ActivationHistory, result: ActivationEnvelope): ActivationHistory {
  if (!result.success)
    return state
  const identifiers = new Set(state.activatedToolIds)
  result.state.activatedTools.forEach(tool => identifiers.add(tool.identifier))
  const skills = new Map(state.activatedSkills.map(skill => [skill.id, skill]))
  for (const skill of result.state.activatedSkills) {
    skills.delete(skill.id)
    skills.set(skill.id, skill)
  }
  if (identifiers.size === state.activatedToolIds.length && result.state.activatedSkills.length === 0)
    return state
  return { ...state, activatedToolIds: [...identifiers], activatedSkills: [...skills.values()] }
}

function parseRequest(value: unknown): string[] | undefined {
  try {
    const result = requestSchema.safeParse(typeof value === 'string' ? JSON.parse(value) : value)
    return result.success ? result.data.identifiers : undefined
  }
  catch {
    return undefined
  }
}

function validReceipt(state: ActivationHistory, receipt: ActivationReceipt, callId: string, identifiers: readonly string[]): boolean {
  return receipt.success
    && receipt.commit.callId === callId
    && (!receipt.approvalRequired || (state.approvedCalls ?? []).includes(callId))
    && receipt.state.activatedTools.every(tool => identifiers.includes(tool.identifier) && receipt.commit.activatedToolIds.includes(tool.identifier))
    && receipt.state.activatedSkills.every(skill => identifiers.includes(skill.name) && receipt.commit.activatedSkills.some(item => item.id === skill.id && item.name === skill.name))
}

export function foldActivationEvent(state: ActivationHistory, event: SessionEvent): ActivationHistory {
  if (event.type === 'tool/call' && event.data.name === ACTIVATOR_TOOL_NAME) {
    const identifiers = parseRequest(event.data.arguments)
    if (!identifiers)
      return state
    return {
      ...state,
      pendingCalls: [...new Set([...state.pendingCalls, event.data.callId])],
      pendingRequests: [...(state.pendingRequests ?? []).filter(item => item.callId !== event.data.callId), { callId: event.data.callId, identifiers }],
    }
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
    if (!request && pending.length === 0)
      return state
    let next: ActivationHistory = {
      ...state,
      pendingCalls: state.pendingCalls.filter(id => id !== message.toolCallId),
      ...(state.pendingRequests ? { pendingRequests: state.pendingRequests.filter(item => item.callId !== message.toolCallId) } : {}),
      ...(state.pendingActivations ? { pendingActivations: state.pendingActivations.filter(item => item.parentCallId !== message.toolCallId) } : {}),
      ...(state.approvedCalls ? { approvedCalls: state.approvedCalls.filter(id => id !== message.toolCallId) } : {}),
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
      const identifiers = parseRequest(event.data.arguments)
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
    if (hasPending) {
      return {
        ...state,
        pendingCalls: [],
        ...(state.pendingRequests ? { pendingRequests: [] } : {}),
        ...(state.pendingActivations ? { pendingActivations: [] } : {}),
        ...(state.approvalRequests ? { approvalRequests: [] } : {}),
        ...(state.approvedCalls ? { approvedCalls: [] } : {}),
      }
    }
  }
  return state
}
