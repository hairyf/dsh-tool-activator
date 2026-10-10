import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ActivationEnvelope, ActivationHistory, ActivationReceipt, ActivationResult } from './types'
import { z } from 'zod'
import { ACTIVATION_PRODUCER, ACTIVATION_VERSION } from './constants'

export const activatedSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.string(),
  title: z.string(),
  hasResources: z.boolean(),
  provider: z.string().optional(),
  instructions: z.string().optional(),
})

export const activationEnvelopeSchema = z.object({
  producer: z.literal(ACTIVATION_PRODUCER),
  version: z.literal(ACTIVATION_VERSION),
  content: z.string(),
  success: z.boolean(),
  state: z.object({
    activatedTools: z.array(z.object({
      apiCount: z.number().int().nonnegative(),
      avatar: z.string().optional(),
      identifier: z.string(),
      name: z.string(),
    })),
    activatedSkills: z.array(activatedSkillSchema),
    alreadyActive: z.array(z.string()),
    notFound: z.array(z.string()),
  }),
})

export const activationCommitSchema = z.object({
  producer: z.literal(ACTIVATION_PRODUCER),
  version: z.literal(ACTIVATION_VERSION),
  callId: z.string(),
  activatedToolIds: z.array(z.string()),
  activatedSkills: z.array(activatedSkillSchema),
})

export const activationReceiptSchema = activationEnvelopeSchema.extend({
  authorized: z.literal(true),
  approvalRequired: z.boolean(),
  commit: activationCommitSchema,
})

export const activationHistorySchema = z.object({
  activatedToolIds: z.array(z.string()),
  activatedSkills: z.array(activatedSkillSchema),
  pendingCalls: z.array(z.string()),
  pendingActivations: z.array(z.object({ callId: z.string(), parentCallId: z.string(), activation: activationReceiptSchema })).optional(),
  pendingRequests: z.array(z.object({ callId: z.string(), identifiers: z.array(z.string()) })).optional(),
  approvalRequests: z.array(z.object({ id: z.string(), callId: z.string() })).optional(),
  approvedCalls: z.array(z.string()).optional(),
}) satisfies z.ZodType<ActivationHistory>

function sanitizeEnvelope(value: ActivationEnvelope): ActivationEnvelope {
  return {
    ...value,
    state: {
      ...value.state,
      activatedTools: value.state.activatedTools.map(({ avatar, ...tool }) => avatar === undefined ? tool : { ...tool, avatar }),
      activatedSkills: value.state.activatedSkills.map(({ provider, instructions, ...skill }) => ({
        ...skill,
        ...(provider === undefined ? {} : { provider }),
        ...(instructions === undefined ? {} : { instructions }),
      })),
    },
  }
}

export function activationEnvelope(result: ActivationResult): ActivationEnvelope {
  const state = activationEnvelopeSchema.shape.state.safeParse(result.state)
  return sanitizeEnvelope({
    producer: ACTIVATION_PRODUCER,
    version: ACTIVATION_VERSION,
    content: result.content,
    success: result.success,
    state: state.success
      ? state.data
      : { activatedTools: [], activatedSkills: [], alreadyActive: [], notFound: [] },
  })
}

export function parseActivation(value: unknown): ActivationEnvelope | undefined {
  const result = activationEnvelopeSchema.safeParse(value)
  return result.success ? sanitizeEnvelope(result.data) : undefined
}

export function parseReceipt(value: unknown): ActivationReceipt | undefined {
  const result = activationReceiptSchema.safeParse(value)
  if (!result.success)
    return undefined
  return {
    ...sanitizeEnvelope(result.data),
    authorized: true,
    approvalRequired: result.data.approvalRequired,
    commit: {
      ...result.data.commit,
      activatedSkills: sanitizeEnvelope({ ...result.data, state: { ...result.data.state, activatedSkills: result.data.commit.activatedSkills } }).state.activatedSkills,
    },
  }
}

export function receiptFromContent(content: readonly ContentBlock[]): ActivationReceipt | undefined {
  for (const block of content) {
    if (block.type !== 'text')
      continue
    try {
      const parsed = parseReceipt(JSON.parse(block.text))
      if (parsed)
        return parsed
    }
    catch {}
  }
  return undefined
}

export function activationFromContent(content: readonly ContentBlock[]): ActivationEnvelope | undefined {
  for (const block of content) {
    if (block.type !== 'text')
      continue
    try {
      const parsed = parseActivation(JSON.parse(block.text))
      if (parsed)
        return parsed
    }
    catch {}
  }
  return undefined
}

export function activationContent(value: ActivationEnvelope): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}
