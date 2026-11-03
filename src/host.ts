import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SkillDefinition, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolActivatorConfig } from './config'
import type { ToolPolicy } from './shared'
import type { ActivateToolsParams, ActivationEnvelope, ActivationHistory, ActivationReceipt, ActivationResult, AssembledPrompt, ToolCatalogItem } from './types'
import { createDeveloperMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { activationContent, activationEnvelope, activationHistorySchema, parseActivation } from './activation'
import { buildToolCatalog, enabledToolNames } from './catalog'
import { validatePolicy } from './config'
import { ACTIVATION_CONTEXT_NAME, ACTIVATION_CONTEXT_ORDER, ACTIVATION_PRODUCER, ACTIVATION_PROJECTION_KEY, ACTIVATION_VERSION, ACTIVATOR_SOURCE_KIND, ACTIVATOR_TOOL_NAME } from './constants'
import { createToolHiding } from './hiding'
import { emptyActivationHistory, foldActivationEvent, mergeActivation } from './history'
import { filterPromptAssembly, immediateToolNames } from './prompt'
import { provideToolActivatorRemote } from './remote'
import { ActivatorExecutionRuntime } from './runtime'
import { loadToolSdkRenderers } from './sdk-render'
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

/**
 * Hosts from dsh 0.2.2 on hand the assembly waterfall a presentation and merge the
 * provider-owned tool schemas afterwards, so this plugin can no longer hide tool
 * declarations there. Say so once rather than on every agent.
 */
let reportedDeclarationsUnavailable = false

function reportDeclarationsUnavailable(): void {
  if (reportedDeclarationsUnavailable)
    return
  reportedDeclarationsUnavailable = true
  console.warn('[dsh-tool-activator] prompt assembly no longer carries tool declarations (dsh >= 0.2.2); inactive tools are hidden with a scoped restriction instead of by filtering the assembly')
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
  const hiding = createToolHiding(ctx)
  // An agent's enabled set only grows: activations are permanent, and the catalog
  // that feeds this reads a projection the commit folds on its own schedule. Without
  // the union, an assembly that runs before that fold would re-hide the tool the
  // commit just declared — visible as "I activated it and it disappeared".
  const enabledSeen = new WeakMap<Agent, Set<string>>()

  /** Install the hiding gate for one agent, never narrowing what it already saw. */
  function applyHiding(agent: Agent, catalog: ToolCatalogItem[], enabled: ReadonlySet<string>): void {
    const previous = enabledSeen.get(agent)
    const merged = new Set(enabled)
    if (previous !== undefined) {
      for (const name of previous)
        merged.add(name)
    }
    enabledSeen.set(agent, merged)
    hiding.sync(agent, catalog, merged)
  }
  // Latched from the first assembly: hosts that own tool declarations hand the
  // waterfall a presentation without them, and only those need hiding by
  // restriction. `undefined` means no assembly has revealed the host yet.
  let declarationsOwned: boolean | undefined
  // Learn the host's declaration contract once, before any agent exists: whether the
  // waterfall still receives `tools` decides if hiding is even needed, and the first
  // turn has to know it too. A scope-less assembly is enough to tell.
  const probe = ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    declarationsOwned ??= Array.isArray((assembly as AssembledPrompt).tools)
    return next()
  }, { prepend: true })
  void Promise.resolve()
    .then(async () => ctx.systemPrompt.assemble({}))
    .catch(() => { })
    .finally(() => probe())
  // A step resolves its tool set BEFORE it assembles, so an agent that already
  // existed when this plugin loaded (a restored session) would spend its first
  // step with every tool declared — the assembly hook then hides them, which is
  // the one-step-late "tools added, then removed" flicker. Answering inside
  // `tools.view()` instead makes the first read correct no matter who created
  // the agent or when this plugin loaded.
  hiding.setGateResolver((agent) => {
    if (declarationsOwned === true)
      return
    const policy = policySnapshot()
    const catalog = catalogOf(agent, policy)
    applyHiding(agent, catalog, enabledToolNames(catalog, policy, activatedIdsOf(agent)))
  })
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
    // `tools` rides along only on hosts that still let this waterfall own the
    // declarations; newer hosts merge the provider-owned schemas afterwards.
    const ownsDeclarations = Array.isArray((assembly as AssembledPrompt).tools)
    declarationsOwned = ownsDeclarations
    // The agent view hides the tools this plugin restricted away, so lift the
    // restriction for the length of the read; sync installs it again below.
    if (!ownsDeclarations)
      hiding.suspend(agent)
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
    if (!ownsDeclarations) {
      // The host keeps the declarations, so hide the un-activated ones with a
      // scoped restriction: that removes them from this agent's model surface and
      // from its callable set alike, which is what an inactive tool should be.
      applyHiding(agent, catalog, enabled)
      reportDeclarationsUnavailable()
    }
    const instructions = enabled.has('skill') && ctx.tools.get('skill', agent)
      ? history.activatedSkills.flatMap(skill => skill.instructions === undefined ? [] : [skill.instructions])
      : []
    const sdk = assembly.sections.some(section => section.name === 'tools:sdk' && section.text.length > 0)
      ? await renderSdk(agent, ctx.tools.schemas(agent).filter(schema => schema.name !== 'run_code' && enabled.has(schema.name)))
      : undefined
    const appending = await supportsToolAdditions(agent)
    if (appending)
      announce(agent, enabled, policy)
    // The installed host types predate provider-owned declarations: they still
    // declare the waterfall result as a full assembly, while 0.2.2 merges `tools`
    // afterwards and accepts the presentation returned here.
    return filterPromptAssembly(assembly as AssembledPrompt, catalog, policy, enabled, sdk, instructions, appending) as PromptAssembly
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
  ctx.on('agent/created', ({ agent }) => {
    // Hiding must be in place before a fresh agent's first assembly, so the probe
    // installed at load has to answer the host question by now.
    if (declarationsOwned !== false)
      return
    const policy = policySnapshot()
    hiding.suspend(agent)
    const catalog = catalogOf(agent, policy)
    // A restored session's agent is new, but its session already carries the tools
    // it activated: the gate must keep them visible, or the first request after a
    // restart would drop tools the model had already been given.
    applyHiding(agent, catalog, enabledToolNames(catalog, policy, activatedIdsOf(agent)))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    hiding.forget(agent)
    clearAgent(agent)
  })
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

  /**
   * The tools this session already activated. An empty list is the safe answer: the
   * gate then hides what was never activated, and the next assembly widens it from
   * the recovered history.
   */
  function activatedIdsOf(agent: Agent): readonly string[] {
    try {
      return historyOf(agent).activatedToolIds
    }
    catch {
      return []
    }
  }

  function catalogOf(agent: Agent, policy: ToolPolicy): ToolCatalogItem[] {
    // The catalog is the directory `activate_tools` offers, so it must be read
    // with the hiding gate lifted: with the gate in place every un-activated tool
    // reads as absent and every activation answers `Not found`.
    return hiding.readAll(agent, () => buildToolCatalog(ctx.tools.schemas(agent), policy))
  }

  async function renderSdk(agent: Agent, candidates: ReturnType<Context['tools']['schemas']>): Promise<string> {
    const { renderToolsSdk, renderToolsSdkPy } = await loadToolSdkRenderers()
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
      // The next step resolves its tool set BEFORE the assembly hook runs, so a
      // gate refreshed there would leave exactly one step without the tool the
      // model was just told it had. Install it on the COMMIT instead: the same
      // turn's next step then both sees the declaration and may call it.
      applyHiding(agent, catalog, enabledToolNames(catalog, policy, history.activatedToolIds))
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
