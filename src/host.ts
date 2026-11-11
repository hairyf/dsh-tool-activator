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
import type { GroupingFacts } from './groups'
import type { ToolPolicy } from './shared'
import type { ActivateToolsParams, ActivationEnvelope, ActivationHistory, ActivationReceipt, ActivationResult, AssembledPrompt, GroupApplyReceipt, GroupingToolParams, GroupingToolResult, ToolCatalogItem } from './types'
import { createDeveloperMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { activationContent, activationEnvelope, activationHistorySchema, parseActivation } from './activation'
import { createToolHiding } from './admission-gating'
import { buildToolCatalog, enabledToolNames } from './catalog'
import { validatePolicy } from './config'
import { ACTIVATION_PRODUCER, ACTIVATION_PROJECTION_KEY, ACTIVATION_STATE_VERSION, ACTIVATION_VERSION, ACTIVATOR_SOURCE_KIND, ACTIVATOR_TOOL_NAME, BASIC_GROUP_IDENTIFIER, LOCKED_TOOL_NAMES } from './constants'
import { settingsNamespaceOf, settingsServiceOf, writeGroups } from './group-writer'
import { applyGroupOps, groupingSnapshot } from './groups'
import { emptyActivationHistory, foldActivationEvent, mergeActivation } from './history'
import { createCatalogPublisher } from './injection'
import { immediateToolNames, preparePromptAssembly } from './prompt'
import { provideToolActivatorRemote } from './remote'
import { ActivatorExecutionRuntime, explainNotFound } from './runtime'
import { loadToolSdkRenderers } from './sdk-render'
import { createActivatorTool, createGroupingTool } from './tool'
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
/**
 * A host that owns the declarations and exposes no step admission leaves the plugin
 * nowhere to hide an un-activated tool: the model would see all of them.
 */
let reportedMissingAdmission = false

function reportDeclarationsUnavailable(): void {
  if (reportedDeclarationsUnavailable)
    return
  reportedDeclarationsUnavailable = true
  console.warn('[dsh-tool-activator] prompt assembly no longer carries tool declarations (dsh >= 0.2.2); inactive tools are hidden by narrowing the step admission instead of by filtering the assembly')
}

function reportMissingAdmission(): void {
  if (reportedMissingAdmission)
    return
  reportedMissingAdmission = true
  console.warn('[dsh-tool-activator] this host owns the tool declarations and exposes no tool admission (tools.resolve); inactive tools cannot be hidden from the model')
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

/**
 * Whether an applied batch changed anything at all. A batch that changed
 * nothing has no reason to be written back into the configuration.
 */
function changedAnything(receipt: GroupApplyReceipt): boolean {
  return receipt.created.length > 0 || receipt.updated.length > 0
    || receipt.removed.length > 0 || receipt.renamed.length > 0
}

/**
 * The tool names a rename or a removal would drop from the activation account.
 *
 * A group identifier dies with the group, so a session that activated the group
 * loses its claim on the members once the group is renamed or removed. The names
 * travel with the result instead: the session log folds them into the account,
 * and the tools the session already had stay callable.
 */
function migrationNames(facts: GroupingFacts, receipt: GroupApplyReceipt, history: ActivationHistory): string[] {
  const targets = [...receipt.renamed.map(item => item.from), ...receipt.removed]
  const known = new Set(history.activatedToolNames ?? [])
  const names: string[] = []
  for (const identifier of targets) {
    if (!history.activatedToolIds.includes(identifier))
      continue
    const group = facts.groups.find(entry => entry.identifier === identifier)
    if (!group)
      continue
    for (const tool of group.tools) {
      if (!known.has(tool)) {
        known.add(tool)
        names.push(tool)
      }
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
  /** Publishes the tool catalog as this plugin's own message. */
  const publisher = createCatalogPublisher()
  /** Sessions this plugin assembled a prompt for. */
  const assembledSessions = new WeakSet<Session>()
  /** Sessions this plugin admitted a catalog into. */
  const admittedSessions = new WeakSet<Session>()
  let reportedMissingStepAdmission = false
  /**
   * The host admits a step through its waterfall; without it the catalog can
   * never reach the model, and the plugin would silently do half its job.
   */
  function reportMissingStepAdmission(): void {
    if (reportedMissingStepAdmission)
      return
    reportedMissingStepAdmission = true
    console.warn('[dsh-tool-activator] the host starts steps without dispatching agent/pre-step, so the tool catalog cannot reach the model')
  }
  // An agent's enabled set only grows: activations are permanent, and the catalog
  // that feeds this reads a projection the commit folds on its own schedule. Without
  // the union, an assembly that runs before that fold would re-hide the tool the
  // commit just declared — visible as "I activated it and it disappeared".
  const enabledSeen = new WeakMap<Agent, Set<string>>()

  /**
   * Install the hiding gate for one agent, never narrowing what it already saw. The
   * merged set is returned: the prompt has to present exactly what the gate lets
   * the model call, or a tool the gate keeps would be offered as inactive.
   */
  function applyHiding(agent: Agent, catalog: ToolCatalogItem[], enabled: ReadonlySet<string>): Set<string> {
    const previous = enabledSeen.get(agent)
    const merged = new Set(enabled)
    if (previous !== undefined) {
      for (const name of previous)
        merged.add(name)
    }
    enabledSeen.set(agent, merged)
    hiding.sync(agent, catalog, merged)
    return merged
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
  // step with every tool admitted — the assembly hook then narrows them, which is
  // the one-step-late "tools added, then removed" flicker. Resolving the
  // allow-list inside the admission instead makes the first resolution correct no
  // matter who created the agent or when this plugin loaded.
  hiding.setGateResolver((agent) => {
    if (declarationsOwned === true)
      return
    const policy = policySnapshot()
    const catalog = catalogOf(agent, policy)
    applyHiding(agent, catalog, enabledNamesOf(catalog, policy, activatedHistoryOf(agent)))
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
  const groupingTool = createGroupingTool(executeGrouping)

  ctx.effect(() => () => {
    lifetime.abort()
    executions.clear()
    receipts.clear()
    announcements.clear()
  })
  ctx.sessionProjections.register({
    key: ACTIVATION_PROJECTION_KEY,
    stateSchema: activationHistorySchema,
    stateVersion: ACTIVATION_STATE_VERSION,
    init: emptyActivationHistory,
    apply: foldActivationEvent,
  })
  ctx.tools.register(tool)
  ctx.tools.register(groupingTool)
  provideToolActivatorRemote(ctx, policySnapshot)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const policy = policySnapshot()
    if (!context.agent)
      return assembly
    const agent = requireAgent(context.agent)
    assembledSessions.add(agent.session)
    if (context.scope !== agent)
      throw new Error('dsh-tool-activator requires the exact agent scope for prompt assembly')
    context.signal?.throwIfAborted()
    // `tools` rides along only on hosts that still let this waterfall own the
    // declarations; newer hosts merge the provider-owned schemas afterwards.
    const ownsDeclarations = Array.isArray((assembly as AssembledPrompt).tools)
    declarationsOwned = ownsDeclarations
    const catalog = catalogOf(agent, policy)
    const history = historyOf(agent)
    const computed = enabledNamesOf(catalog, policy, history)
    if (ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) === undefined) {
      // Nothing named activate_tools is visible in this scope — a restriction
      // denied it or the host never exposed it. Hiding the discoverable tools
      // would then hand the model a directory it cannot act on, so present the
      // untouched assembly instead. A scope-local registration of the same name
      // merely shadows ours, and filtering stays correct there because the model
      // still has something to call under that name.
      // Without the activator the model gets no catalog to read.
      publisher.forget(agent)
      return assembly
    }
    // The presentation and the gate read the same set: the gate keeps what the
    // session already had, so the prompt presents what the model may actually call.
    // A host that owns the declarations has no gate to follow, so it keeps the
    // computed set.
    const enabled = ownsDeclarations ? computed : applyHiding(agent, catalog, computed)
    if (!ownsDeclarations) {
      // The host owns the declarations, so the hiding happens where the model
      // reads them: the step admission. Narrowing it removes the un-activated
      // tools from this agent's model surface and from its callable set alike,
      // which is what an inactive tool should be.
      reportDeclarationsUnavailable()
      if (!hiding.installed)
        reportMissingAdmission()
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
    const prepared = preparePromptAssembly(assembly as AssembledPrompt, catalog, policy, enabled, sdk, instructions, appending)
    publisher.prepare(agent, prepared.catalog)
    return prepared.assembly as PromptAssembly
  })
  /**
   * Publish the catalog as this plugin's own message.
   *
   * The step waterfall is where the host admits the messages a step sends, so
   * the catalog joins them there: it lands in the history after the cached
   * prefix, and a change to it never rewrites the system prompt. Another
   * plugin's runtime context cannot drag it along, because the host compares
   * that context as one merged snapshot and this message is not part of it.
   */
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted)
      return decision
    admittedSessions.add(payload.agent.session)
    const message = publisher.publish(payload.agent)
    if (message === undefined)
      return decision
    return { ...decision, messages: [...decision.messages, message] }
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
    const catalog = catalogOf(agent, policy)
    // A restored session's agent is new, but its session already carries the tools
    // it activated: the gate must keep them visible, or the first request after a
    // restart would drop tools the model had already been given.
    applyHiding(agent, catalog, enabledNamesOf(catalog, policy, activatedHistoryOf(agent)))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    hiding.forget(agent)
    clearAgent(agent)
  })
  ctx.on('session/event', (session, event) => {
    const state = announcements.get(session.id)
    if (state)
      foldAnnouncement(state, event)
    // The host opens a step only after its admission waterfall ran: a step that
    // starts without our listener seeing it means the waterfall is missing.
    if (event.type === 'step/start' && assembledSessions.has(session) && !admittedSessions.has(session))
      reportMissingStepAdmission()
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
   * The activation history this session recovered. An empty history is the safe answer:
   * the gate then hides what was never activated, and the next assembly widens it from
   * the recovered history.
   */
  function activatedHistoryOf(agent: Agent): ActivationHistory {
    try {
      return historyOf(agent)
    }
    catch {
      return emptyActivationHistory()
    }
  }

  /**
   * The tools this session may call: the basic tools, the activated entries and the
   * activated tool names. The names are what survives a group that was renamed or
   * split after the session activated it, so they count on their own.
   */
  function enabledNamesOf(catalog: ToolCatalogItem[], policy: ToolPolicy, history: ActivationHistory): Set<string> {
    return enabledToolNames(catalog, policy, history.activatedToolIds, history.activatedToolNames)
  }

  function catalogOf(agent: Agent, policy: ToolPolicy): ToolCatalogItem[] {
    // The catalog is the directory `activate_tools` offers. It reads the
    // registry's real face, so every tool this installation can offer is in it —
    // the activation narrows the model's access, not the registry's truth.
    return buildToolCatalog(ctx.tools.schemas(agent), policy)
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
    const enabled = enabledNamesOf(catalog, policy, history)
    const active = catalog.filter(entry => entry.tools.every(schema => enabled.has(schema.name))).map(entry => entry.identifier)
    const skillDefinition = ctx.tools.get('skill', agent)
    const skillService = skills
    let skillCall = 0
    const runtime = new ActivatorExecutionRuntime({
      getActiveIdentifiers: identifiers => active.filter(identifier => identifiers.includes(identifier)),
      getToolManifests: async identifiers => catalog.filter(entry => identifiers.includes(entry.identifier)),
      markActivated: () => { },
      // 陈旧标识符值得拿到原因而不是一句 not found：配置中的分组分支正是
      // 插件被卸载的场景。
      explainNotFound: identifier => explainNotFound(identifier, {
        activatedToolIds: history.activatedToolIds,
        groups: new Set(policy.groups.map(group => group.identifier)),
      }),
      ...(enabled.has('skill') && skillDefinition && skillService
        ? {
            activateSkill: async ({ name }: { name: string }): Promise<ActivationResult> => {
              const options = await lookupOptions(agent, signal)
              const skill = await loadSkill(skillService, name, options)
              const current = requireExecution(agent, record, signal)
              const currentEnabled = enabledNamesOf(catalogOf(agent, current), current, historyOf(agent))
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

  /**
   * Read the grouping state of the current scope, or write a batch of group
   * edits into the plugin's own configuration.
   *
   * The batch is all-or-nothing: a rejected batch answers with every problem it
   * has and writes nothing, and an accepted batch is written as one conditional
   * document mutation.
   */
  async function executeGrouping(args: GroupingToolParams, exec: ToolRunContext): Promise<GroupingToolResult> {
    const agent = requireAgent(exec.agent)
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    signal.throwIfAborted()
    const policy = policySnapshot()
    const catalog = catalogOf(agent, policy)
    const facts: GroupingFacts = {
      groups: policy.groups,
      tools: catalog.flatMap(entry => entry.tools.map(tool => tool.name)),
      basicTools: policy.basicTools,
      lockedTools: LOCKED_TOOL_NAMES,
    }
    if (args.action !== 'apply')
      return { action: 'list', ...groupingSnapshot(facts) }
    // `apply` without an operation is a malformed call, not a no-op: answering
    // with an empty receipt would tell the model it changed something it did not.
    if ((args.ops ?? []).length === 0)
      throw new Error('The "apply" action needs at least one operation in "ops"; no change was made.')
    const outcome = applyGroupOps(facts, args.ops ?? [])
    if (outcome.problems.length > 0)
      return { action: 'apply', problems: outcome.problems }
    // The members of a renamed or removed group would drop out of the account with
    // the identifier that died with the group, so they travel with the result and
    // the session log folds them back in.
    const migrated = migrationNames(facts, outcome.receipt, activatedHistoryOf(agent))
    // A batch that changed nothing is not written back: the write is a
    // read-modify-write of the whole document, and rewriting it unchanged
    // could only overwrite what the user changed in the meantime. The names still
    // travel: they are the only thing such a call has to account for.
    if (!changedAnything(outcome.receipt))
      return { action: 'apply', receipt: outcome.receipt, ...(migrated.length > 0 ? { migrated } : {}) }
    const service = settingsServiceOf(ctx)
    if (!service) {
      throw new Error('dsh-tool-activator cannot write tool groups: this host does not provide the settings service, so no change was made. Ask the user to edit the groups in the tool activator settings.')
    }
    const ns = settingsNamespaceOf(ctx)
    if (!ns) {
      throw new Error('dsh-tool-activator cannot write tool groups: this plugin instance has no settings namespace, so no change was made. Ask the user to edit the groups in the tool activator settings.')
    }
    signal.throwIfAborted()
    // The always-loaded set is written in the same mutation as the groups, but
    // only when this batch actually touched it.
    const basicChanged = outcome.receipt.updated.includes(BASIC_GROUP_IDENTIFIER)
    await writeGroups(service, ns, outcome.next, signal, basicChanged ? outcome.nextBasicTools : undefined)
    return { action: 'apply', receipt: outcome.receipt, ...(migrated.length > 0 ? { migrated } : {}) }
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
      const enabled = enabledNamesOf(catalog, policy, historyOf(agent))
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
      applyHiding(agent, catalog, enabledNamesOf(catalog, policy, history))
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
