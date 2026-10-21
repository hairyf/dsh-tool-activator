import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SkillDefinition, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolActivatorConfig } from './config'
import type { ToolPolicy } from './shared'
import type { ActivateToolsParams, ActivationEnvelope, ActivationHistory, ActivationReceipt, ActivationResult, ToolCatalogItem } from './types'
import { createDeveloperMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import { activationContent, activationEnvelope, activationHistorySchema, parseActivation } from './activation'
import { buildToolCatalog, enabledToolNames } from './catalog'
import { validatePolicy } from './config'
import { ACTIVATION_CONTEXT_NAME, ACTIVATION_CONTEXT_ORDER, ACTIVATION_PRODUCER, ACTIVATION_PROJECTION_KEY, ACTIVATION_VERSION, ACTIVATOR_SOURCE_KIND, ACTIVATOR_TOOL_NAME } from './constants'
import { emptyActivationHistory, foldActivationEvent, mergeActivation } from './history'
import { filterPromptAssembly, immediateToolNames } from './prompt'
import { provideToolActivatorRemote } from './remote'
import { ActivatorExecutionRuntime } from './runtime'
import { createActivatorTool } from './tool'
import './session-projection'

interface ActivationExecution {
  agent: Agent
  identifiers: ReadonlySet<string>
  approved: boolean
}

interface PtcReceipt {
  agent: Agent
  parent: ToolExecutionToken
  rootCallId: string
  receipt: ActivationReceipt
}

interface DirectoryCapability {
  ensure: (agent: Agent, signal?: AbortSignal) => Promise<string>
}

/**
 * What one session's request head already declares. Activation must not rewrite
 * that head — a changed declaration list costs the provider's whole cached
 * prefix — so a newly enabled tool is announced with a `tool_addition` after the
 * cached history instead.
 */
interface AnnouncementState {
  headerSeq?: SessionSeq
  headerTools: Set<string>
  turn: number
  step: number
  /**
   * A `developer/message` is a step-scoped event: outside an open step the log
   * rejects it as corrupt. `step/end` closes the step before the next
   * `step/start`, so the last known coordinates are not writable in that gap.
   */
  stepOpen: boolean
}

/** Fold one session event into what this session's head already declares. */
function foldAnnouncement(state: AnnouncementState, event: SessionEvent): void {
  if (event.type === 'request/header') {
    state.headerSeq = event.seq
    state.headerTools = new Set((event.data.header.tools ?? []).map(tool => tool.name))
  }
  if ('turn' in event.data && 'step' in event.data) {
    state.turn = event.data.turn
    state.step = event.data.step
  }
  if (event.type === 'step/start')
    state.stepOpen = true
  else if (event.type === 'step/end')
    state.stepOpen = false
}

/**
 * Tools an earlier `tool_addition` already serves. Read from the current
 * surface rather than the log: a fold that drops the announcement has to be
 * re-issued, or the model silently loses a tool it already activated.
 */
function announcedNames(session: Session): Set<string> {
  const names = new Set<string>()
  for (const message of session.deriveMessages()) {
    if (message.role !== 'developer' || message.source.kind !== ACTIVATOR_SOURCE_KIND)
      continue
    for (const block of message.content) {
      if (block.type === 'tool-addition')
        names.add(block.toolName)
    }
  }
  return names
}

export function installToolActivator(ctx: Context, config: ToolActivatorConfig): void {
  const lifetime = new AbortController()
  const executions = new Map<ToolExecutionToken, ActivationExecution>()
  const receipts = new Map<string, PtcReceipt>()
  const announcements = new Map<string, AnnouncementState>()
  let approval: Context['approval'] | undefined
  let skills: Context['skills'] | undefined
  ctx.inject(['approval'], (owner) => {
    const service = owner.approval
    approval = service
    owner.effect(() => () => {
      if (approval === service)
        approval = undefined
    })
  })
  ctx.inject(['skills'], (owner) => {
    const service = owner.skills
    skills = service
    owner.effect(() => () => {
      if (skills === service)
        skills = undefined
    })
  })
  const tool = createActivatorTool(execute)
  tool.finalizeContent = finalize

  ctx.effect(() => () => {
    lifetime.abort()
    executions.clear()
    receipts.clear()
    announcements.clear()
  })
  ctx.sessionProjections.register({
    key: ACTIVATION_PROJECTION_KEY,
    stateSchema: activationHistorySchema,
    stateVersion: ACTIVATION_VERSION,
    init: emptyActivationHistory,
    apply: foldActivationEvent,
  })
  ctx.tools.register(tool)
  provideToolActivatorRemote(ctx, policySnapshot)
  ctx.systemPrompt.variable('tool_activator_context', () => '')
  ctx.systemPrompt.context({
    name: ACTIVATION_CONTEXT_NAME,
    order: ACTIVATION_CONTEXT_ORDER,
    text: '{{tool_activator_context}}',
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const policy = policySnapshot()
    if (!context.agent)
      return assembly
    const agent = requireAgent(context.agent)
    if (context.scope !== agent)
      throw new Error('dsh-tool-activator requires the exact agent scope for prompt assembly')
    context.signal?.throwIfAborted()
    const catalog = catalogOf(agent, policy)
    const history = historyOf(agent)
    const enabled = enabledToolNames(catalog, policy, history.activatedToolIds)
    if (ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) === undefined) {
      // Nothing named activate_tools is visible in this scope — a restriction
      // denied it or the host never exposed it. Hiding the discoverable tools
      // would then hand the model a directory it cannot act on, so present the
      // untouched assembly instead. A scope-local registration of the same name
      // merely shadows ours, and filtering stays correct there because the model
      // still has something to call under that name.
      return assembly
    }
    const instructions = enabled.has('skill') && ctx.tools.get('skill', agent)
      ? history.activatedSkills.flatMap(skill => skill.instructions === undefined ? [] : [skill.instructions])
      : []
    const sdk = assembly.sections.some(section => section.name === 'tools:sdk' && section.text.length > 0)
      ? renderSdk(agent, ctx.tools.schemas(agent).filter(schema => schema.name !== 'run_code' && enabled.has(schema.name)))
      : undefined
    const appending = await supportsToolAdditions(agent)
    if (appending)
      announce(agent, enabled, policy)
    return filterPromptAssembly(assembly, catalog, policy, enabled, sdk, instructions, appending)
  })
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const content = await next()
    const record = receipts.get(dispatch.subCallId)
    if (!record)
      return content
    receipts.delete(dispatch.subCallId)
    if (dispatch.isError || dispatch.name !== ACTIVATOR_TOOL_NAME || dispatch.agent !== record.agent
      || dispatch.exec.token !== record.parent || dispatch.exec.rootCallId !== record.rootCallId
      || lifetime.signal.aborted || ctx.agents.get(record.agent.id) !== record.agent) {
      return content
    }
    return activationContent(record.receipt)
  }, { prepend: true })
  ctx.on('tools/result', (exec) => {
    executions.delete(exec.token)
    for (const [callId, record] of receipts) {
      if (record.parent === exec.token)
        receipts.delete(callId)
    }
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => clearAgent(agent))
  ctx.on('session/event', (session, event) => {
    const state = announcements.get(session.id)
    if (state)
      foldAnnouncement(state, event)
    if (event.type !== 'turn/end')
      return
    for (const [token, value] of executions) {
      if (value.agent.session === session)
        executions.delete(token)
    }
    for (const [callId, value] of receipts) {
      if (value.agent.session === session)
        receipts.delete(callId)
    }
  })

  function policySnapshot(): ToolPolicy {
    const policy = config.get()
    validatePolicy(policy)
    return policy
  }

  function requireAgent(agent: Agent | undefined): Agent {
    if (lifetime.signal.aborted || !agent || ctx.agents.get(agent.id) !== agent)
      throw new Error('dsh-tool-activator requires an exact live agent')
    return agent
  }

  /**
   * Whether this route reads tool declarations that change mid-conversation.
   * Routes without the capability must keep an exactly-filtered declaration
   * list: deferring there would either leak every hidden schema or hide a tool
   * the model can never load.
   */
  async function supportsToolAdditions(agent: Agent): Promise<boolean> {
    // Options are known before the first request; the logged request context
    // only appears after it, and the very first request must already carry the
    // stable declaration list.
    const route = agent.session.requestContext()
    const provider = agent.options.provider ?? route?.provider
    const model = agent.options.model ?? route?.model
    const llm = ctx.get('llm')
    if (!provider || !model || !llm)
      return false
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return info.toolUpdate !== undefined
    }
    catch {
      return false
    }
  }

  /**
   * Announce newly enabled tools after the cached history. One `tool_addition`
   * loads a deferred declaration without touching the request head, so the
   * provider's cached prefix survives.
   */
  function announce(agent: Agent, enabled: ReadonlySet<string>, policy: ToolPolicy): void {
    const session = agent.session
    const state = announcementState(session)
    if (state.headerSeq === undefined || !state.stepOpen)
      return
    const immediate = immediateToolNames(policy)
    const candidates = [...enabled].filter(name => !immediate.has(name) && state.headerTools.has(name))
    if (candidates.length === 0)
      return
    const announced = announcedNames(session)
    const pending = candidates.filter(name => !announced.has(name))
    if (pending.length === 0)
      return
    session.append('developer/message', {
      turn: state.turn,
      step: state.step,
      headerSeq: state.headerSeq,
      message: createDeveloperMessage({
        source: { kind: ACTIVATOR_SOURCE_KIND },
        content: pending.map(name => ({ type: 'tool-addition' as const, toolName: name })),
      }),
    }, { surfaceOp: 'append' })
  }

  function announcementState(session: Session): AnnouncementState {
    const existing = announcements.get(session.id)
    if (existing)
      return existing
    const created: AnnouncementState = { headerTools: new Set(), turn: 0, step: 0, stepOpen: false }
    for (const event of session.snapshotEvents())
      foldAnnouncement(created, event)
    announcements.set(session.id, created)
    return created
  }

  function requiresApproval(agent: Agent, policy: ToolPolicy): boolean {
    return policy.requireApproval && ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode !== 'danger-full-access'
  }

  function requireExecution(agent: Agent, record: ActivationExecution, signal: AbortSignal): ToolPolicy {
    signal.throwIfAborted()
    requireAgent(agent)
    const policy = policySnapshot()
    if ((requiresApproval(agent, policy) && !record.approved) || ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) !== tool)
      throw new Error('Tool activation is disabled or its configuration changed before the request could commit')
    return policy
  }

  function historyOf(agent: Agent): ActivationHistory {
    const history = ctx.sessionProjections.stateOf(agent.session, ACTIVATION_PROJECTION_KEY)
    if (!history)
      throw new Error('dsh-tool-activator activation projection is unavailable')
    return history
  }

  function catalogOf(agent: Agent, policy: ToolPolicy): ToolCatalogItem[] {
    return buildToolCatalog(ctx.tools.schemas(agent), policy)
  }

  function renderSdk(agent: Agent, candidates: ReturnType<Context['tools']['schemas']>): string {
    const schemas: Parameters<typeof renderToolsSdk>[0] = []
    for (const schema of candidates) {
      if (schema.name === 'run_code')
        continue
      const definition = ctx.tools.get(schema.name, agent)
      if (definition)
        schemas.push({ ...schema, output: definition.output.schema })
    }
    const language = ctx.get('ptcRuntime')?.language
    if (language === 'typescript')
      return renderToolsSdk(schemas)
    if (language === 'python')
      return renderToolsSdkPy(schemas)
    throw new Error(`dsh-tool-activator cannot present the PTC SDK for language ${String(language)}`)
  }

  async function lookupOptions(agent: Agent, signal: AbortSignal): Promise<SkillViewOptions> {
    const directory = ctx.get('workingDirectory') as DirectoryCapability | undefined
    const cwd = directory && typeof directory.ensure === 'function'
      ? await directory.ensure(agent, signal)
      : agent.session.header.cwd
    signal.throwIfAborted()
    requireAgent(agent)
    return { scope: agent, signal, ...(cwd === undefined ? {} : { cwd }) }
  }

  async function loadSkill(service: Context['skills'], name: string, options: SkillViewOptions): Promise<SkillDefinition | undefined> {
    const summary = (await service.list(options)).find(skill => skill.name === name && skill.invocation.modelInvocable)
    if (!summary || skills !== service)
      return undefined
    const definition = await service.get(name, options)
    return definition?.invocation.modelInvocable ? definition : undefined
  }

  async function execute(args: ActivateToolsParams, exec: ToolRunContext): Promise<ActivationEnvelope> {
    const agent = requireAgent(exec.agent)
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    signal.throwIfAborted()
    const initialPolicy = policySnapshot()
    if (ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) !== tool)
      throw new Error('Tool activation is disabled by the current plugin configuration or scope')
    const record: ActivationExecution = { agent, identifiers: new Set(args.identifiers), approved: false }
    executions.set(exec.token, record)
    if (requiresApproval(agent, initialPolicy)) {
      const approver = approval
      if (!approver)
        throw new Error('Tool activation requires approval, but the approval service is unavailable')
      const outcome = await approver.request({ agent, toolName: ACTIVATOR_TOOL_NAME, callId: exec.callId, reason: args.reason, signal })
      signal.throwIfAborted()
      if (outcome !== 'allowed-once' || approval !== approver)
        throw new Error(`Tool activation was not approved (${outcome})`)
      record.approved = true
    }
    const policy = requireExecution(agent, record, signal)
    const catalog = catalogOf(agent, policy)
    const history = historyOf(agent)
    const enabled = enabledToolNames(catalog, policy, history.activatedToolIds)
    const active = catalog.filter(entry => entry.tools.every(schema => enabled.has(schema.name))).map(entry => entry.identifier)
    const skillDefinition = ctx.tools.get('skill', agent)
    const skillService = skills
    let skillCall = 0
    const runtime = new ActivatorExecutionRuntime({
      getActivatedToolIds: () => active,
      getToolManifests: async identifiers => catalog.filter(entry => identifiers.includes(entry.identifier)),
      markActivated: () => {},
      ...(enabled.has('skill') && skillDefinition && skillService
        ? {
            activateSkill: async ({ name }: { name: string }): Promise<ActivationResult> => {
              const options = await lookupOptions(agent, signal)
              const skill = await loadSkill(skillService, name, options)
              const current = requireExecution(agent, record, signal)
              const currentEnabled = enabledToolNames(catalogOf(agent, current), current, historyOf(agent).activatedToolIds)
              if (!skill || !currentEnabled.has('skill') || ctx.tools.get('skill', agent) !== skillDefinition || skills !== skillService)
                return { content: `Skill ${name} is not available.`, success: false }
              const result = await ctx.tools.execute({
                agent,
                name: 'skill',
                callId: ToolCallId(`${exec.callId}:skill:${++skillCall}`),
                rootCallId: exec.rootCallId,
                parent: exec.token,
                arguments: { name },
                signal,
              })
              requireExecution(agent, record, signal)
              if (result.isError)
                return { content: result.error.message, success: false }
              const instructions = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
              return {
                content: `Skill ${name} activated. Usage instructions for the activated items are in the system prompt.`,
                success: true,
                state: {
                  id: skill.name,
                  name: skill.name,
                  description: skill.description,
                  source: skill.source,
                  title: skill.name,
                  hasResources: skill.resourceBase !== undefined,
                  provider: skill.provider,
                  instructions,
                },
              }
            },
          }
        : {}),
    })
    const result = activationEnvelope(await runtime.activateTools(args))
    requireExecution(agent, record, signal)
    return result
  }

  function finalize(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined {
    if (result.isError)
      return undefined
    try {
      const issued = executions.get(exec.token)
      const agent = requireAgent(exec.agent)
      const policy = policySnapshot()
      if (!issued || issued.agent !== agent || exec.signal.aborted
        || (requiresApproval(agent, policy) && !issued.approved) || ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) !== tool) {
        return [{ type: 'text', text: 'Tool activation was not committed because the live scope, approval, or configuration changed. Retry after checking the current tool catalog.' }]
      }
      const activation = parseActivation(result.value)
      if (!activation?.success)
        return undefined
      const catalog = catalogOf(agent, policy)
      const available = new Set(catalog.map(item => item.identifier))
      const enabled = enabledToolNames(catalog, policy, historyOf(agent).activatedToolIds)
      const accepted: ActivationEnvelope = {
        ...activation,
        state: {
          ...activation.state,
          activatedTools: activation.state.activatedTools.filter(item => issued.identifiers.has(item.identifier) && available.has(item.identifier)),
          activatedSkills: activation.state.activatedSkills.filter(item => issued.identifiers.has(item.name) && enabled.has('skill') && ctx.tools.get('skill', agent)),
        },
      }
      const history = mergeActivation(historyOf(agent), accepted)
      const receipt: ActivationReceipt = {
        ...accepted,
        authorized: true,
        approvalRequired: requiresApproval(agent, policy),
        commit: {
          producer: ACTIVATION_PRODUCER,
          version: ACTIVATION_VERSION,
          callId: exec.callId,
          activatedToolIds: history.activatedToolIds.filter(id => available.has(id)),
          activatedSkills: history.activatedSkills,
        },
      }
      if (exec.parent)
        receipts.set(exec.callId, { agent, parent: exec.parent, rootCallId: exec.rootCallId, receipt })
      return activationContent(receipt)
    }
    catch {
      return [{ type: 'text', text: 'Tool activation was not committed because its final state could not be validated. Retry after checking the current tool catalog.' }]
    }
  }

  function clearAgent(agent: Agent): void {
    for (const [token, value] of executions) {
      if (value.agent === agent)
        executions.delete(token)
    }
    for (const [callId, value] of receipts) {
      if (value.agent === agent)
        receipts.delete(callId)
    }
    announcements.delete(agent.session.id)
  }
}
