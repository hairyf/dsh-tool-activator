import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import type { ToolCallId as CallId, ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ToolActivatorConfig } from './config'
import type { ToolPolicy } from './shared'
import type { ActivationCatalog } from './types'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { SandboxPolicyService, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { renderContextSnapshot, renderPrompt, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ApprovalService, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it } from 'vitest'
import { receiptFromContent } from './activation'
import { Config } from './config'
import { ACTIVATION_PROJECTION_KEY, ACTIVATOR_SOURCE_KIND, SETTINGS_REMOTE_NAMESPACE } from './constants'
import * as plugin from './index'
import { catalogMessages } from './injection'

const cleanups: Array<() => unknown> = []
/** Absolute on every platform; DSH rejects a session header whose cwd is not absolute. */
const FIXTURE_CWD = join(tmpdir(), 'isolated-activator-fixture')
/** Registered by the fixture but absent from `DEFAULT_POLICY.basicTools`, so it stays on-demand. */
const DISCOVERABLE_TOOL = 'pwsh'
const DISCOVERABLE_GUIDE = 'PWSh FULL GUIDE'
/** Registered into an agent own scope by another plugin, the way hashline tools are. */
const AGENT_SCOPED_TOOL = 'agent_scoped'

class IntegrationPtcRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'test-provider'
  inputs: PtcRunSpec[] = []

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? FIXTURE_CWD, timeoutMs: null }
  }

  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    this.inputs.push(spec)
    const tools = spec.bindings.find(namespace => namespace.global === 'tools')!.functions
    try {
      const value = await tools.activate_tools({ identifiers: [DISCOVERABLE_TOOL], reason: `Run ${DISCOVERABLE_TOOL}` })
      if (spec.program === 'activate then fail')
        return { logs: [], error: { kind: 'exception', message: 'The fixture program failed after activation' } }
      return { logs: [], value }
    }
    catch (error) {
      return { logs: [], error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) } }
    }
  }
}

/**
 * The settings service of a host, reduced to the calls the plugin makes. The
 * fixture has no real host behind it, so the service records what it was asked.
 */
class FakeSettingsService {
  revision = 3
  readonly mutations: Array<{ ns: string, ops: ReadonlyArray<{ op: 'set', path: string[], value: unknown }>, expectedRevision?: number }> = []

  describe(): Array<{ ns: string, revision: number }> {
    return [{ ns: 'tool-activator', revision: this.revision }]
  }

  async mutate(ns: string, ops: ReadonlyArray<{ op: 'set', path: string[], value: unknown }>, expectedRevision?: number): Promise<void> {
    this.mutations.push({ ns, ops, expectedRevision })
  }
}
interface FixtureOptions {
  policy?: Parameters<typeof Config>[0]
  mode?: 'native' | 'ptc' | 'both'
  approval?: boolean
  approvalPolicy?: ApprovalPolicy
  sandboxMode?: SandboxMode
  skills?: boolean
  runtimeContext?: boolean
  spill?: boolean
  /** Emulate dsh 0.2.2: the waterfall carries no tool declarations. */
  withoutDeclarations?: boolean
  /** Create the agent BEFORE the plugin loads, the way a restored session does. */
  restoredAgent?: boolean
  /** A fake host settings service; the plugin writes its groups through it. */
  settings?: FakeSettingsService
}

interface Driver {
  agent: Agent
  events: SessionEvent[]
  close: () => Promise<void>
}

interface Fixture {
  ctx: Context
  fiber: Fiber
  ptc: IntegrationPtcRuntime | undefined
  makeAgent: (id: string, seed?: readonly SessionEvent[]) => Promise<Driver>
  /** The agent that predates the plugin load, when the fixture created one. */
  restored: Driver | undefined
  setPolicy: (changes: Partial<ToolPolicy>) => void
  setHostContext: (text: string) => void
}

function unused(): never {
  throw new Error('This host integration fixture does not drive an agent loop or inbox')
}

const inbox: Inbox = {
  nextTurn: [],
  nextStep: [],
  clear: unused,
  append: unused,
  prepend: unused,
  replace: unused,
  remove: unused,
  splice: unused,
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const ctx = new Context()
  let current = Config({ requireApproval: false, ...options.policy }).get()
  const config: ToolActivatorConfig = { get: () => current }
  const services: Fiber[] = []
  cleanups.push(async () => {
    for (const fiber of services.reverse())
      await fiber.dispose()
  })
  services.push(await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: options.runtimeContext ?? true }))
  services.push(await ctx.plugin(SessionStore))
  services.push(await ctx.plugin(AgentRegistry))
  services.push(await ctx.plugin(SessionProjectionRegistry))
  if (options.sandboxMode)
    services.push(await ctx.plugin(SandboxPolicyService, { mode: options.sandboxMode, workspaceRoot: FIXTURE_CWD }))
  let ptc: IntegrationPtcRuntime | undefined
  if (options.mode && options.mode !== 'native') {
    services.push(await ctx.plugin((owner: Context) => {
      ptc = new IntegrationPtcRuntime(owner)
    }))
  }
  services.push(await ctx.plugin(ToolRuntime, { mode: options.mode ?? 'native' }))
  // dsh 0.2.2 resolves a step admission before it assembles, and the provider
  // reads THAT set instead of the registry. The rc.2 host has neither, so the
  // fixture supplies the admission contract: a `resolve` that yields the scope's
  // real face, which the plugin narrows to the enabled tools.
  Object.defineProperty(ctx.tools, 'resolve', {
    configurable: true,
    writable: true,
    value: async (context: { agent?: Agent }) => {
      const visible = new Map(ctx.tools.schemas(context.agent).map(schema => [schema.name, schema]))
      return {
        dispose: () => { },
        view: (scope?: unknown) => scope === context.agent ? visible : new Map(),
      }
    },
  })
  if (options.approval)
    services.push(await ctx.plugin(ApprovalService, { policy: options.approvalPolicy ?? 'ask' }))
  if (options.skills)
    services.push(await ctx.plugin(SkillRegistry, {}))
  if (options.settings) {
    const settings = options.settings
    services.push(await ctx.plugin((owner: Context) => {
      owner.provide('settings', settings)
    }))
  }
  if (options.spill) {
    cleanups.push(ctx.on('tools/ptc-dispatch-log', async (_dispatch, next) => {
      await next()
      return [{ type: 'text', text: 'Spilled to a result locator' }]
    }))
  }
  let turn = 0
  const makeAgent = async (id: string, seed: readonly SessionEvent[] = []): Promise<Driver> => {
    const session = ctx.sessions.create(SessionId(id), { ...(seed.length === 0 ? {} : { seed }), meta: { cwd: FIXTURE_CWD } })
    const events: SessionEvent[] = [...seed]
    const unobserve = ctx.on('session/event', (subject, event) => {
      if (subject === session)
        events.push(event)
    })
    const agent = {
      id: session.id,
      session,
      ctx,
      options: {},
      status: 'idle' as const,
      inbox,
      cancel: unused,
      whenIdle: async (): Promise<void> => {},
      runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
      send: unused,
      followup: unused,
      steer: unused,
      inject: unused,
    } satisfies Agent
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    const unregister = await ctx.agents.register(agent)
    const close = async (): Promise<void> => {
      await unregister()
      await scope.dispose()
      unobserve()
    }
    cleanups.push(close)
    session.append('turn/start', { turn: ++turn })
    session.append('step/start', { turn, step: 1 })
    return { agent, events, close }
  }
  // A restored session's agent exists before the plugin loads, so it never sees
  // `agent/created`: the case the lazy gate resolver exists for.
  const restored = options.restoredAgent ? await makeAgent('restored') : undefined
  const fiber = await ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply(owner: Context): void {
      plugin.apply(owner, config)
    },
  })
  services.push(fiber)
  if (options.settings) {
    // A plugin writes under the id of its own loader entry; the fixture has no
    // loader, so the entry is faked on the plugin fiber.
    Reflect.set(fiber, 'entry', { options: { id: 'tool-activator' } })
  }
  if (options.withoutDeclarations) {
    // dsh 0.2.2 hands the waterfall a presentation WITHOUT tool declarations and
    // merges the provider-owned schemas afterwards. Deleting the declarations in
    // place emulates that contract for the rc.2 fixture. The hook has to run
    // BEFORE the plugin's own probe — that probe reads the declarations off the
    // payload to learn whether the host owns them — hence `prepend`.
    cleanups.push(ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      Reflect.deleteProperty(assembly, 'tools')
      return next()
    }, { prepend: true }))
  }
  for (const name of ['read', 'write', 'glob', 'grep', DISCOVERABLE_TOOL, 'web_search']) {
    cleanups.push(ctx.tools.register(defineTool({
      name,
      description: `${name} description`,
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => `${name}:${args.path}`,
    })))
  }
  for (const name of ['read', 'write'])
    cleanups.push(ctx.systemPrompt.section({ name: `tool:${name}`, order: 100, text: `${name.toUpperCase()} FULL GUIDE` }))
  cleanups.push(ctx.systemPrompt.section({ name: `tool:${DISCOVERABLE_TOOL}`, order: 100, text: DISCOVERABLE_GUIDE }))
  cleanups.push(ctx.systemPrompt.section({ name: 'tool:web_search', order: 100, text: 'WEB SEARCH FULL GUIDE' }))
  cleanups.push(ctx.systemPrompt.section({ name: 'host:safety', order: 1, text: 'HOST SAFETY NEVER REMOVED' }))
  let hostContext = 'HOST RUNTIME NEVER REMOVED'
  cleanups.push(ctx.systemPrompt.context({ name: 'host:runtime', order: 1, text: () => hostContext }))
  return {
    ctx,
    fiber,
    get ptc(): IntegrationPtcRuntime | undefined { return ptc },
    makeAgent,
    restored,
    setPolicy(changes): void {
      current = Config(JSON.parse(JSON.stringify({ ...current, ...changes }))).get()
    },
    setHostContext(text: string): void {
      hostContext = text
    },
  }
}

function startCall(session: Session, name: string, args: unknown, callId: CallId): void {
  const argumentsJson = JSON.stringify(args)
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name, arguments: argumentsJson }],
      source: { provider: 'fixture', model: 'fixture' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, name, callId, arguments: argumentsJson })
}

async function call(ctx: Context, agent: Agent, name: string, args: unknown, id = 'fixture-call', signal = new AbortController().signal): Promise<ReturnType<Context['tools']['execute']> extends Promise<infer T> ? T : never> {
  const callId = ToolCallId(id)
  startCall(agent.session, name, args, callId)
  const result = await ctx.tools.execute({ agent, name, arguments: args, callId, signal })
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
    ...(result.meta === undefined ? {} : { meta: result.meta }),
  }, { surfaceOp: 'append' })
  return result
}

async function presentation(ctx: Context, agent: Agent): Promise<{ names: string[], text: string }> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
  await admitStep(ctx, agent)
  return { names: (assembly.tools ?? []).map(tool => tool.name), text: `${renderPrompt(assembly)}\n${renderContextSnapshot(assembly)}\n${catalogText(agent)}` }
}

/**
 * Admit one step the way the host does: the step waterfall decides which
 * messages enter the step, and the host appends them to the session.
 */
async function admitStep(ctx: Context, agent: Agent): Promise<UserMessage[]> {
  const decision = await ctx.waterfall(
    scopeTarget(agent, agent),
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'reject')
    return []
  for (const message of decision.messages)
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  return decision.messages
}

/** The catalog the model currently holds. */
function catalogText(agent: Agent): string {
  const messages = catalogMessages(agent)
  const [block] = messages[messages.length - 1]?.content ?? []
  return block?.type === 'text' ? block.text : ''
}

/** The model-facing text of one tool result. */
function resultText(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function closeTurn(session: Session): void {
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve: (value: T) => void = unused
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('real rc.2 host contracts', () => {
  it('initially exposes only basic schemas and a schema-free discoverable directory', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('initial')
    const initial = await presentation(ctx, agent)
    expect(initial.names).toEqual(['activate_tools', 'glob', 'grep', 'read', 'write'])
    expect(initial.text).toContain(`<tool identifier="${DISCOVERABLE_TOOL}" name="${DISCOVERABLE_TOOL}">${DISCOVERABLE_TOOL}: ${DISCOVERABLE_TOOL} description</tool>`)
    expect(initial.text).toContain('READ FULL GUIDE')
    expect(initial.text).toContain('WRITE FULL GUIDE')
    expect(initial.text).not.toContain(DISCOVERABLE_GUIDE)
    expect(initial.text).toContain('HOST SAFETY NEVER REMOVED')
    expect(initial.text).toContain('HOST RUNTIME NEVER REMOVED')
    expect(ctx.tools.get(DISCOVERABLE_TOOL, agent)).toBeDefined()
  })

  it('commits only a final native receipt and presents schemas plus instructions on the next request', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent, events } = await makeAgent('native')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(receiptFromContent(result.content)).toMatchObject({
      producer: 'dsh-tool-activator',
      version: 1,
      authorized: true,
      approvalRequired: false,
      commit: { callId: 'fixture-call', activatedToolIds: [DISCOVERABLE_TOOL], activatedSkills: [] },
      state: { activatedTools: [{ identifier: DISCOVERABLE_TOOL, apiCount: 1, name: DISCOVERABLE_TOOL }], activatedSkills: [], alreadyActive: [], notFound: [] },
    })
    expect(events.map(event => event.type)).toEqual(['turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result'])
    const enabled = await presentation(ctx, agent)
    expect(enabled.names).toEqual(['activate_tools', 'glob', 'grep', DISCOVERABLE_TOOL, 'read', 'write'])
    expect(enabled.text).toContain(DISCOVERABLE_GUIDE)
    expect(enabled.text.match(/WRITE FULL GUIDE/gu)).toHaveLength(1)
    expect(enabled.text).toContain('<available_tools description="These tools are installed but not yet enabled. Use activate_tools to enable them when needed.">')
    expect(enabled.text).toContain('  <tool identifier="group_tools" name="group_tools">')
    expect(enabled.text).toContain('  <tool identifier="web_search" name="web_search">web_search: web_search description</tool>\n</available_tools>')
    expect(enabled.text).not.toContain(`<tool identifier="${DISCOVERABLE_TOOL}" name="${DISCOVERABLE_TOOL}">`)
    const again = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL, 'missing'], reason: 'Check the tools' }, 'already-active')
    expect(receiptFromContent(again.content)?.state).toEqual({ activatedTools: [], activatedSkills: [], alreadyActive: [DISCOVERABLE_TOOL], notFound: ['missing'] })
  })

  it('does not activate from a successful execution until its durable call/result pair commits', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('before-durable-result')
    const callId = ToolCallId('not-yet-logged')
    startCall(agent.session, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' }, callId)
    const result = await ctx.tools.execute({ agent, name: 'activate_tools', arguments: { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' }, callId, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
    agent.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) }, { surfaceOp: 'append' })
    expect((await presentation(ctx, agent)).names).toContain(DISCOVERABLE_TOOL)
  })

  it('recovers activation from serialized history in a new session, but not an unrelated blank session', async () => {
    const { ctx, makeAgent } = await fixture()
    const original = await makeAgent('source-session')
    await call(ctx, original.agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    closeTurn(original.agent.session)
    const serialized: SessionEvent[] = JSON.parse(JSON.stringify(original.events))
    const restored = await makeAgent('restored-session', serialized)
    const fresh = await makeAgent('fresh-session')
    expect((await presentation(ctx, restored.agent)).names).toEqual(['activate_tools', 'glob', 'grep', DISCOVERABLE_TOOL, 'read', 'write'])
    expect((await presentation(ctx, fresh.agent)).names).toEqual(['activate_tools', 'glob', 'grep', 'read', 'write'])
  })

  it('restores only the current restricted scope and refuses unavailable identifiers', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('restricted')
    const restriction = await agent.ctx.plugin({
      inject: ['tools'],
      apply(owner: Context): void {
        owner.tools.restrict({ deny: [DISCOVERABLE_TOOL] })
      },
    })
    cleanups.push(() => restriction.dispose())
    expect((await presentation(ctx, agent)).text).not.toContain(`identifier="${DISCOVERABLE_TOOL}"`)
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Try the shell' })
    expect(receiptFromContent(result.content)?.state.notFound).toEqual([DISCOVERABLE_TOOL])
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
    const direct = await call(ctx, agent, DISCOVERABLE_TOOL, { path: 'script.ps1' }, 'denied-shell')
    expect(direct.isError).toBe(true)
  })

  it('presents the untouched tool set when the activator itself is denied for the scope', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('no-activator')
    const restriction = await agent.ctx.plugin({
      inject: ['tools'],
      apply(owner: Context): void {
        owner.tools.restrict({ deny: ['activate_tools'] })
      },
    })
    cleanups.push(() => restriction.dispose())
    const visible = await presentation(ctx, agent)
    expect(visible.names).not.toContain('activate_tools')
    expect(visible.names).toContain(DISCOVERABLE_TOOL)
    expect(visible.text).not.toContain('<available_tools')
  })

  it('keeps filtering when the scope registers its own activate_tools', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('shadowed-activator')
    const shadow = await agent.ctx.plugin({
      inject: ['tools'],
      apply(owner: Context): void {
        owner.tools.register(defineTool({
          name: 'activate_tools',
          description: 'scope-local activator',
          parameters: { path: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async args => `shadow:${args.path}`,
        }))
      },
    })
    cleanups.push(() => shadow.dispose())
    const visible = await presentation(ctx, agent)
    expect(visible.names).toContain('activate_tools')
    expect(visible.names).not.toContain(DISCOVERABLE_TOOL)
  })

  it('activates every authorized API in an explicit group without exposing shared docs', async () => {
    const { ctx, makeAgent } = await fixture({ policy: {
      basicTools: ['read'],
      groups: [{ identifier: 'files', name: 'Files', description: 'File utilities', tools: ['pwsh', 'web_search', 'grep'], sections: ['plugin:files'] }],
      // `not_registered` is never available, so the shared section stays hidden.
      sectionTools: { 'plugin:files': ['pwsh', 'web_search', 'not_registered'] },
    } })
    cleanups.push(ctx.systemPrompt.section({ name: 'plugin:files', order: 110, text: 'SHARED HIDDEN GUIDE' }))
    const { agent } = await makeAgent('grouped')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: ['files'], reason: 'Use file utilities' })
    expect(receiptFromContent(result.content)?.state.activatedTools).toEqual([{ identifier: 'files', name: 'Files', apiCount: 3, tools: ['grep', 'pwsh', 'web_search'] }])
    const enabled = await presentation(ctx, agent)
    expect(enabled.names).toEqual(['activate_tools', 'grep', 'pwsh', 'read', 'web_search'])
    expect(enabled.text).not.toContain('SHARED HIDDEN GUIDE')
    expect(enabled.text).not.toContain('WRITE FULL GUIDE')
    expect(enabled.text).toContain('WEB SEARCH FULL GUIDE')
  })

  it('honors removal of every basic tool while keeping the activator and on-demand loading', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture()
    const { agent } = await makeAgent('empty-basics')
    expect((await presentation(ctx, agent)).names).toContain('read')

    setPolicy({ basicTools: [] })
    const pending = await presentation(ctx, agent)
    expect(pending.names).toEqual(['activate_tools'])
    expect(pending.text).toContain('<tool identifier="read" name="read">')
    expect(pending.text).not.toContain('READ FULL GUIDE')
    expect(pending.text).not.toContain('WRITE FULL GUIDE')

    const result = await call(ctx, agent, 'activate_tools', { identifiers: ['read'], reason: 'Read a file on demand' })
    expect(result.isError).toBe(false)
    const activated = await presentation(ctx, agent)
    expect(activated.names).toEqual(['activate_tools', 'read'])
    expect(activated.text).toContain('READ FULL GUIDE')
    expect(activated.text).not.toContain('WRITE FULL GUIDE')

    const fresh = await makeAgent('empty-basics-fresh')
    expect((await presentation(ctx, fresh.agent)).names).toEqual(['activate_tools'])
  })

  it('keeps a committed activation when the configuration is unchanged', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture()
    const { agent } = await makeAgent('stable-config')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError).toBe(false)
    setPolicy({ requireApproval: true })
    expect((await presentation(ctx, agent)).names).toContain(DISCOVERABLE_TOOL)
  })

  it('rejects stale or mismatched agent scopes and leaves agentless diagnostic assembly untouched', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('scope-identity')
    await expect(ctx.systemPrompt.assemble({ scope: {}, agent })).rejects.toThrow('exact agent scope')
    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['activate_tools', 'glob', 'grep', 'group_tools', DISCOVERABLE_TOOL, 'read', 'web_search', 'write'])
    const stale = { ...agent }
    await expect(ctx.systemPrompt.assemble({ scope: stale, agent: stale })).rejects.toThrow('exact live agent')
    expect((await call(ctx, stale, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })).isError).toBe(true)
  })

  it('keeps the user complete prompt while delivering activated docs exactly once through the catalog', async () => {
    const { ctx, makeAgent } = await fixture()
    cleanups.push(ctx.systemPrompt.section({ name: 'user:complete', order: 0, complete: true, text: 'USER COMPLETE PROMPT' }))
    const { agent } = await makeAgent('complete-prompt')
    await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
    expect(renderPrompt(assembly)).toBe('USER COMPLETE PROMPT')
    expect(renderContextSnapshot(assembly)).not.toContain(DISCOVERABLE_GUIDE)
    const visible = await presentation(ctx, agent)
    expect(visible.text.match(/PWSh FULL GUIDE/gu)).toHaveLength(1)
  })

  it('keeps publishing the catalog when the host suppresses its runtime context', async () => {
    const { ctx, makeAgent } = await fixture({ runtimeContext: false })
    const { agent } = await makeAgent('no-runtime-context')
    const visible = await presentation(ctx, agent)
    expect(visible.text).toContain('<available_tools')
    expect(visible.text).not.toContain('HOST RUNTIME NEVER REMOVED')
  })

  it('publishes the catalog as its own message instead of a runtime context', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('own-injection')
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
    expect(assembly.contexts.map(context => context.name)).toEqual(['host:runtime'])
    await presentation(ctx, agent)
    const published = catalogMessages(agent)
    expect(published).toHaveLength(1)
    expect(published[0]!.source).toMatchObject({ kind: ACTIVATOR_SOURCE_KIND, form: 'catalog' })
    expect(catalogText(agent)).toContain('<available_tools')
  })

  it('does not publish the catalog again while nothing changed', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('stable-catalog')
    await presentation(ctx, agent)
    await presentation(ctx, agent)
    expect(catalogMessages(agent)).toHaveLength(1)
  })

  it('publishes the catalog again once an activation changes it', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('changed-catalog')
    await presentation(ctx, agent)
    await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    await presentation(ctx, agent)
    expect(catalogMessages(agent)).toHaveLength(2)
    expect(catalogText(agent)).toContain(`<tool identifier="${DISCOVERABLE_TOOL}" names="${DISCOVERABLE_TOOL}"/>`)
  })

  it('keeps its catalog when another contributor changes the runtime context', async () => {
    const { ctx, makeAgent, setHostContext } = await fixture()
    const { agent } = await makeAgent('foreign-context')
    await presentation(ctx, agent)
    setHostContext('HOST RUNTIME CHANGED')
    const visible = await presentation(ctx, agent)
    expect(visible.text).toContain('HOST RUNTIME CHANGED')
    expect(catalogMessages(agent)).toHaveLength(1)
  })

  it('does not publish the same catalog twice in a restored session', async () => {
    const { ctx, makeAgent } = await fixture()
    const original = await makeAgent('catalog-source-session')
    await presentation(ctx, original.agent)
    closeTurn(original.agent.session)
    const serialized: SessionEvent[] = JSON.parse(JSON.stringify(original.events))
    const restored = await makeAgent('catalog-restored-session', serialized)
    await presentation(ctx, restored.agent)
    expect(catalogMessages(restored.agent)).toHaveLength(1)
  })

  it('unloads every registration and rebuilds durable state on plugin reload', async () => {
    const { ctx, fiber, makeAgent } = await fixture()
    const { agent } = await makeAgent('reload')
    await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    await fiber.dispose()
    expect(ctx.tools.get('activate_tools', agent)).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(agent.session, 'tool-activator:activation')).toBeUndefined()
    const without = await ctx.systemPrompt.assemble({ scope: agent, agent })
    // The plugin contributes no runtime context of its own: the catalog travels
    // as its own message, so only the host's context is left.
    expect(without.contexts.map(context => context.name)).toEqual(['host:runtime'])
    const reloaded = await ctx.plugin({ inject: plugin.inject, apply: (owner: Context): void => plugin.apply(owner, Config({ requireApproval: false })) })
    cleanups.push(() => reloaded.dispose())
    expect((await presentation(ctx, agent)).names).toEqual(['activate_tools', 'glob', 'grep', DISCOVERABLE_TOOL, 'read', 'write'])
  })
})

describe('real approval and final policy boundary', () => {
  it.each(['native', 'ptc'] as const)('activates under full access with never approval in %s mode and restores the receipt', async (mode) => {
    const { ctx, makeAgent } = await fixture({ mode, policy: { requireApproval: true }, approval: true, sandboxMode: 'read-only' })
    const { agent, events } = await makeAgent(`full-access-${mode}`)
    setSandboxMode(agent.session, 'danger-full-access')
    setApprovalPolicy(agent.session, 'never')
    const result = mode === 'native'
      ? await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell with full access' })
      : await call(ctx, agent, 'run_code', { code: 'activate', description: 'Activate with full access' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    const dispatch = events.find(event => event.type === 'tool/ptc-dispatch')
    const content = mode === 'native' ? result.content : dispatch?.type === 'tool/ptc-dispatch' ? dispatch.data.content : []
    expect(receiptFromContent(content)?.approvalRequired).toBe(false)
    expect(events.some(event => event.type === 'approval/asked' || event.type === 'approval/decided')).toBe(false)
    expect((await presentation(ctx, agent)).text).toContain(DISCOVERABLE_GUIDE)
    closeTurn(agent.session)
    const restored = await makeAgent(`full-access-restored-${mode}`, JSON.parse(JSON.stringify(events)))
    expect((await presentation(ctx, restored.agent)).text).toContain(DISCOVERABLE_GUIDE)
  })

  it.each([false, true])('honors a full-access deployment default with approval service present=%s', async (approval) => {
    const { ctx, makeAgent } = await fixture({ policy: { requireApproval: true }, approval, approvalPolicy: 'never', sandboxMode: 'danger-full-access' })
    const { agent, events } = await makeAgent(`full-access-default-${approval}`)
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(receiptFromContent(result.content)?.approvalRequired).toBe(false)
    expect(events.some(event => event.type === 'approval/asked')).toBe(false)
    expect((await presentation(ctx, agent)).names).toContain(DISCOVERABLE_TOOL)
  })

  it.each(['read-only', 'workspace-write'] as const)('still requires approval for a %s session under a full-access deployment default', async (mode) => {
    const { ctx, makeAgent } = await fixture({ policy: { requireApproval: true }, approval: true, approvalPolicy: 'never', sandboxMode: 'danger-full-access' })
    const { agent, events } = await makeAgent(`confined-${mode}`)
    setSandboxMode(agent.session, mode)
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError).toBe(true)
    expect(events.some(event => event.type === 'approval/decided' && event.data.outcome === 'rejected')).toBe(true)
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
  })

  it('does not commit an unapproved activation if full access is revoked during post-execute', async () => {
    const { ctx, makeAgent } = await fixture({ policy: { requireApproval: true }, approval: true, approvalPolicy: 'never', sandboxMode: 'danger-full-access' })
    cleanups.push(ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name === 'activate_tools')
        setSandboxMode(exec.agent!.session, 'read-only')
      return decision
    }))
    const { agent, events } = await makeAgent('full-access-revoked')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'Tool activation was not committed because the live scope, approval, or configuration changed. Retry after checking the current tool catalog.' }])
    expect(receiptFromContent(result.content)).toBeUndefined()
    expect(events.some(event => event.type === 'approval/asked')).toBe(false)
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
  })

  it('still honors core execution guards under full access', async () => {
    const { ctx, makeAgent } = await fixture({ policy: { requireApproval: true }, approval: true, approvalPolicy: 'never', sandboxMode: 'danger-full-access' })
    cleanups.push(ctx.tools.guard(exec => exec.name === 'activate_tools' ? 'Existing core guard denies activation' : undefined))
    const { agent } = await makeAgent('full-access-core-guard')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError).toBe(true)
    expect(receiptFromContent(result.content)).toBeUndefined()
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
  })

  it('requires a real allowed-once audit pair before committing an approval-required activation', async () => {
    const { ctx, makeAgent } = await fixture({ policy: { requireApproval: true }, approval: true })
    const requests: string[] = []
    cleanups.push(ctx.on('approval/request', async (request) => {
      requests.push(`${request.toolName}:${request.callId}:${request.reason}`)
      return 'allowed-once'
    }))
    const { agent, events } = await makeAgent('approved')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell after confirmation' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(requests).toEqual(['activate_tools:fixture-call:Run the shell after confirmation'])
    expect(events.map(event => event.type)).toEqual(['turn/start', 'step/start', 'assistant/message', 'tool/call', 'approval/asked', 'approval/decided', 'tool/result'])
    expect(receiptFromContent(result.content)?.approvalRequired).toBe(true)
    expect((await presentation(ctx, agent)).names).toContain(DISCOVERABLE_TOOL)
  })

  it.each(['missing-service', 'no-answerer', 'rejected', 'cancelled', 'unavailable', 'throwing-answerer'] as const)('fails closed with %s', async (outcome) => {
    const { ctx, makeAgent } = await fixture({ policy: { requireApproval: true }, approval: outcome !== 'missing-service' })
    if (outcome !== 'missing-service' && outcome !== 'no-answerer') {
      cleanups.push(ctx.on('approval/request', async () => {
        if (outcome === 'throwing-answerer')
          throw new Error('No confirmation transport')
        return outcome
      }))
    }
    const { agent } = await makeAgent(`approval-${outcome}`)
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError).toBe(true)
    expect(receiptFromContent(result.content)).toBeUndefined()
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
  })

  it('does not request approval when a core monotonic guard already denies execution', async () => {
    const { ctx, makeAgent } = await fixture({ policy: { requireApproval: true }, approval: true })
    let asks = 0
    cleanups.push(ctx.on('approval/request', async () => {
      asks += 1
      return 'allowed-once'
    }))
    cleanups.push(ctx.tools.guard(exec => exec.name === 'activate_tools' ? 'Existing core guard denies activation' : undefined))
    const { agent } = await makeAgent('core-guard')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError).toBe(true)
    expect(asks).toBe(0)
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
  })

  it('does not mint a receipt for a core post-execute rejection', async () => {
    const { ctx, makeAgent } = await fixture()
    cleanups.push(ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'activate_tools'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'Core policy rejects activation' }] }
      : next()))
    const { agent } = await makeAgent('post-block')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError).toBe(true)
    expect(receiptFromContent(result.content)).toBeUndefined()
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
  })

  it('does not commit a successful body if the caller is cancelled during post-execute', async () => {
    const { ctx, makeAgent } = await fixture()
    const controller = new AbortController()
    cleanups.push(ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name === 'activate_tools')
        controller.abort('User stopped the request')
      return decision
    }))
    const { agent } = await makeAgent('post-cancel')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' }, 'post-cancel-call', controller.signal)
    expect(result.isError).toBe(true)
    expect(receiptFromContent(result.content)).toBeUndefined()
    expect((await presentation(ctx, agent)).names).not.toContain(DISCOVERABLE_TOOL)
  })

  it('rechecks the live scope after an asynchronous approval rather than using a stale snapshot', async () => {
    const { ctx, makeAgent } = await fixture({ policy: { requireApproval: true }, approval: true })
    const entered = deferred<void>()
    const answer = deferred<'allowed-once'>()
    cleanups.push(ctx.on('approval/request', async () => {
      entered.resolve()
      return answer.promise
    }))
    const { agent } = await makeAgent('approval-config-race')
    const pending = call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    await entered.promise
    const restriction = await agent.ctx.plugin({
      inject: ['tools'],
      apply(owner: Context): void {
        owner.tools.restrict({ deny: ['activate_tools'] })
      },
    })
    cleanups.push(() => restriction.dispose())
    answer.resolve('allowed-once')
    const result = await pending
    expect(result.isError).toBe(true)
    expect(receiptFromContent(result.content)).toBeUndefined()
    const state = ctx.sessionProjections.stateOf(agent.session, ACTIVATION_PROJECTION_KEY) as { activatedToolIds?: string[] } | undefined
    expect(state?.activatedToolIds ?? []).toEqual([])
  })
})

describe('real PTC bridge and SDK presentation', () => {
  it.each(['typescript', 'python'])('filters the %s SDK while preserving the run_code transport and PTC-only rule', async (language) => {
    const { ctx, ptc, makeAgent } = await fixture({ mode: 'ptc' })
    ptc!.language = language
    const { agent } = await makeAgent(`sdk-${language}`)
    const before = await presentation(ctx, agent)
    expect(before.names).toEqual(['run_code'])
    expect(before.text).toContain('activate_tools')
    expect(before.text).toContain('WRITE FULL GUIDE')
    expect(before.text).not.toContain(DISCOVERABLE_GUIDE)
    expect(before.text).not.toMatch(new RegExp(language === 'typescript' ? `\\n {2}${DISCOVERABLE_TOOL}: ` : `\\n {4}async def ${DISCOVERABLE_TOOL}\\(`, 'u'))
    const activated = await call(ctx, agent, 'run_code', { code: 'activate', description: 'Activate the shell tool' })
    expect(activated.isError).toBe(false)
    const after = await presentation(ctx, agent)
    expect(after.names).toEqual(['run_code'])
    expect(after.text).toMatch(new RegExp(language === 'typescript' ? `\\n {2}${DISCOVERABLE_TOOL}: ` : `\\n {4}async def ${DISCOVERABLE_TOOL}\\(`, 'u'))
    expect(after.text).toContain(DISCOVERABLE_GUIDE)
    expect(after.text).toContain('run_code')
    const direct = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' }, 'illegal-native-ptc')
    expect(direct.isError).toBe(true)
  })

  it('protects its own durable receipt from a spill listener registered before the plugin', async () => {
    const { ctx, makeAgent } = await fixture({ mode: 'ptc', spill: true })
    const { agent, events } = await makeAgent('spill-order')
    const result = await call(ctx, agent, 'run_code', { code: 'activate', description: 'Activate the shell tool' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    const dispatch = events.find(event => event.type === 'tool/ptc-dispatch')
    expect(dispatch?.type).toBe('tool/ptc-dispatch')
    if (dispatch?.type !== 'tool/ptc-dispatch')
      throw new Error('The real PTC bridge failed to log its dispatch')
    expect(receiptFromContent(dispatch.data.content)).toMatchObject({
      authorized: true,
      commit: { callId: 'fixture-call:ptc:1', activatedToolIds: [DISCOVERABLE_TOOL] },
      state: { activatedTools: [{ identifier: DISCOVERABLE_TOOL, name: DISCOVERABLE_TOOL, apiCount: 1 }] },
    })
    expect(dispatch.data.content).not.toEqual([{ type: 'text', text: 'Spilled to a result locator' }])
    expect((await presentation(ctx, agent)).text).toContain(DISCOVERABLE_GUIDE)
    closeTurn(agent.session)
    const restored = await makeAgent('spill-restored', JSON.parse(JSON.stringify(events)))
    expect((await presentation(ctx, restored.agent)).text).toContain(DISCOVERABLE_GUIDE)
  })

  it('does not retain a PTC sub-activation if the outer program fails after that sub-call succeeds', async () => {
    const { ctx, makeAgent } = await fixture({ mode: 'ptc' })
    const { agent, events } = await makeAgent('outer-failed')
    const result = await call(ctx, agent, 'run_code', { code: 'activate then fail', description: 'Test an outer failure' })
    expect(result.isError).toBe(true)
    expect(events.some(event => event.type === 'tool/ptc-dispatch' && !event.data.isError && receiptFromContent(event.data.content))).toBe(true)
    expect((await presentation(ctx, agent)).text).not.toContain(DISCOVERABLE_GUIDE)
    expect(ctx.sessionProjections.stateOf(agent.session, 'tool-activator:activation')?.activatedToolIds).toEqual([])
  })

  it('preserves approval audit binding to the real PTC sub-call identity', async () => {
    const { ctx, makeAgent } = await fixture({ mode: 'ptc', policy: { requireApproval: true }, approval: true })
    const asks: string[] = []
    cleanups.push(ctx.on('approval/request', async (request) => {
      asks.push(String(request.callId))
      return 'allowed-once'
    }))
    const { agent } = await makeAgent('ptc-approved')
    const result = await call(ctx, agent, 'run_code', { code: 'activate', description: 'Activate after approval' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(asks).toEqual(['fixture-call:ptc:1'])
    expect((await presentation(ctx, agent)).text).toContain(DISCOVERABLE_GUIDE)
  })

  it('presents the PTC SDK for the transport tool', async () => {
    const { ctx, makeAgent } = await fixture({ mode: 'ptc' })
    const { agent } = await makeAgent('ptc-visible')
    const visible = await presentation(ctx, agent)
    expect(visible.names).toEqual(['run_code'])
    expect(visible.text).toMatch(/\n {2}write: /u)
  })
})

describe('real skill fallback and result policy', () => {
  async function skillFixture(): Promise<Fixture> {
    const result = await fixture({ skills: true })
    cleanups.push(result.ctx.skills.register({ name: 'safe-skill', description: 'A scoped safe skill', source: 'runtime', content: 'RAW PRIVATE SKILL INSTRUCTIONS', provider: 'fixture-provider' }))
    cleanups.push(result.ctx.tools.register(defineTool({
      name: 'skill',
      description: 'Load an available skill',
      parameters: { name: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, content: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.content }],
      },
      async execute(args, exec) {
        const skill = await result.ctx.skills.get(args.name, { scope: exec.agent, cwd: exec.agent?.session.header.cwd, signal: exec.signal })
        if (!skill)
          throw new Error('Missing fixture skill')
        return { name: args.name, content: skill.content }
      },
    })))
    return result
  }

  it('accepts typed skill metadata and injects only the final post-policy content, including cold restore', async () => {
    const { ctx, makeAgent } = await skillFixture()
    cleanups.push(ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'skill'
      ? { kind: 'accept', content: [{ type: 'text', text: 'FINAL ACCEPTED SKILL INSTRUCTIONS\nResource directory: safe-fixture' }] }
      : next()))
    const { agent, events } = await makeAgent('skill-approved-output')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: ['safe-skill'], reason: 'Use the skill' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    const receipt = receiptFromContent(result.content)
    expect(receipt?.state.activatedSkills, JSON.stringify(result)).toEqual([{
      id: 'safe-skill',
      name: 'safe-skill',
      description: 'A scoped safe skill',
      source: 'runtime',
      title: 'safe-skill',
      hasResources: false,
      provider: 'fixture-provider',
      instructions: 'FINAL ACCEPTED SKILL INSTRUCTIONS\nResource directory: safe-fixture',
    }])
    const enabled = await presentation(ctx, agent)
    expect(enabled.text).toContain('FINAL ACCEPTED SKILL INSTRUCTIONS')
    expect(enabled.text).toContain('Resource directory: safe-fixture')
    expect(enabled.text).not.toContain('RAW PRIVATE SKILL INSTRUCTIONS')
    closeTurn(agent.session)
    const restored = await makeAgent('restored-skill', JSON.parse(JSON.stringify(events)))
    expect((await presentation(ctx, restored.agent)).text).toContain('FINAL ACCEPTED SKILL INSTRUCTIONS')
    expect((await presentation(ctx, restored.agent)).text).not.toContain('RAW PRIVATE SKILL INSTRUCTIONS')
  })

  it('does not reactivate raw skill instructions when the loader policy blocks the result', async () => {
    const { ctx, makeAgent } = await skillFixture()
    cleanups.push(ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'skill'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'Skill policy denied loading' }] }
      : next()))
    const { agent } = await makeAgent('skill-denied')
    const result = await call(ctx, agent, 'activate_tools', { identifiers: ['safe-skill'], reason: 'Use the skill' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(receiptFromContent(result.content)?.state).toEqual({ activatedTools: [], activatedSkills: [], alreadyActive: [], notFound: ['safe-skill'] })
    expect((await presentation(ctx, agent)).text).not.toContain('RAW PRIVATE SKILL INSTRUCTIONS')
  })
})

describe('activating a tool refreshes the declaration list for the next inference', () => {
  it('declares the activated tool on the very next assembly instead of deferring it', async () => {
    const { ctx, makeAgent } = await fixture()
    cleanups.push(ctx.provide('llm', { resolveModelInfo: async () => ({ toolUpdate: 'addition-only' }) }))
    const { agent, events } = await makeAgent('appending-head')
    agent.options.provider = 'fixture'
    agent.options.model = 'fixture'
    const initial = await ctx.systemPrompt.assemble({ scope: agent, agent })
    const headerSeq = agent.session.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture' }, tools: initial.tools },
      reason: 'initial',
    }).seq

    const result = await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect(result.isError, JSON.stringify(result)).toBe(false)

    const after = await ctx.systemPrompt.assemble({ scope: agent, agent })
    // The commit installs the gate; the assembly hook would be too late, because a
    // step resolves its tool set BEFORE assembling. So the first assembly after the
    // activation — the one this inference is built from — already carries the tool.
    // It arrives as an addition (`deferLoading`), which is how this route declares
    // anything absent from the request head; that flag does not withhold it.
    expect(after.tools.map(tool => tool.name)).toContain(DISCOVERABLE_TOOL)

    const announcement = events.filter(event => event.type === 'developer/message')
    expect(announcement).toHaveLength(1)
    expect(announcement[0]!.data).toMatchObject({
      headerSeq,
      message: { source: { kind: 'tool-activator' }, content: [{ type: 'tool-addition', toolName: DISCOVERABLE_TOOL }] },
    })
  })

  it('announces each newly enabled tool once and never re-announces it', async () => {
    const { ctx, makeAgent } = await fixture()
    cleanups.push(ctx.provide('llm', { resolveModelInfo: async () => ({ toolUpdate: 'addition-only' }) }))
    const { agent, events } = await makeAgent('announce-once')
    agent.options.provider = 'fixture'
    agent.options.model = 'fixture'
    const initial = await ctx.systemPrompt.assemble({ scope: agent, agent })
    agent.session.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture' }, tools: initial.tools },
      reason: 'initial',
    })
    await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    await presentation(ctx, agent)
    await presentation(ctx, agent)
    expect(events.filter(event => event.type === 'developer/message')).toHaveLength(1)
    expect((await presentation(ctx, agent)).text).toContain(DISCOVERABLE_GUIDE)
  })

  it('waits for the next open step instead of writing into a closed one', async () => {
    const { ctx, makeAgent } = await fixture()
    cleanups.push(ctx.provide('llm', { resolveModelInfo: async () => ({ toolUpdate: 'addition-only' }) }))
    const { agent, events } = await makeAgent('announce-closed-step')
    agent.options.provider = 'fixture'
    agent.options.model = 'fixture'
    const initial = await ctx.systemPrompt.assemble({ scope: agent, agent })
    agent.session.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture' }, tools: initial.tools },
      reason: 'initial',
    })
    await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })

    // `developer/message` is step-scoped; between `step/end` and the next
    // `step/start` the last coordinates name a closed step.
    agent.session.append('step/end', { turn: 1, step: 1 })
    await presentation(ctx, agent)
    expect(events.filter(event => event.type === 'developer/message')).toHaveLength(0)

    agent.session.append('step/start', { turn: 1, step: 2 })
    await presentation(ctx, agent)
    const announcements = events.filter(event => event.type === 'developer/message')
    expect(announcements).toHaveLength(1)
    expect(announcements[0]!.data).toMatchObject({ turn: 1, step: 2 })
  })

  it('keeps rewriting the declaration list on a route that cannot read mid-conversation changes', async () => {
    const { ctx, makeAgent } = await fixture()
    cleanups.push(ctx.provide('llm', { resolveModelInfo: async () => ({}) }))
    const { agent, events } = await makeAgent('plain-route')
    agent.options.provider = 'fixture'
    agent.options.model = 'fixture'
    await presentation(ctx, agent)
    await call(ctx, agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    expect((await presentation(ctx, agent)).names).toContain(DISCOVERABLE_TOOL)
    expect(events.filter(event => event.type === 'developer/message')).toHaveLength(0)
  })
})

/**
 * dsh 0.2.2 hands the waterfall a presentation WITHOUT tool declarations and
 * merges the provider-owned schemas afterwards, so the plugin hides through the
 * view gate instead of rewriting the assembly. The rc.2 fixture still owns the
 * declarations, so this block emulates the newer contract instead.
 */
describe('the 0.2.2 contract: the waterfall carries no tool declarations', () => {
  /** The tools one step may call: the model-facing face, not the registry's. */
  async function resolveStep(ctx: Context, agent: Agent): Promise<ReadonlyMap<string, unknown>> {
    const tools = ctx.tools as unknown as {
      resolve: (context: { agent: Agent, modelSelection: { provider: string, model: string }, signal: AbortSignal }) => Promise<{ view: (scope?: unknown) => ReadonlyMap<string, unknown> }>
    }
    const toolSet = await tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal })
    return toolSet.view(agent)
  }

  it('keeps the restored activations visible on the very first read of a restored session', async () => {
    const { ctx, makeAgent } = await fixture({ withoutDeclarations: true })
    // The host contract is learned from the first scoped assembly; in production
    // the load-time probe already knows it.
    const { agent: probe } = await makeAgent('contract-probe')
    await ctx.systemPrompt.assemble({ scope: probe, agent: probe })
    const original = await makeAgent('source-session')
    await call(ctx, original.agent, 'activate_tools', { identifiers: [DISCOVERABLE_TOOL], reason: 'Run the shell' })
    closeTurn(original.agent.session)
    const serialized: SessionEvent[] = JSON.parse(JSON.stringify(original.events))
    const restored = await makeAgent('restored-session', serialized)
    // The first request after a restart resolves its tool set before anything
    // else: the tools the session already activated must still be admitted.
    const admitted = await resolveStep(ctx, restored.agent)
    expect([...admitted.keys()]).toContain(DISCOVERABLE_TOOL)
  })
  it('keeps the discoverable directory whole in the first prompt of a new session', async () => {
    const { ctx, makeAgent } = await fixture({ withoutDeclarations: true })
    const { agent } = await makeAgent('new-session')

    const { text } = await presentation(ctx, agent)
    // The directory is what makes `activate_tools` usable at all: the model has to
    // see which tools exist before it can ask for them.
    expect(text).toContain('<available_tools description="These tools are installed but not yet enabled. Use activate_tools to enable them when needed.">')
    expect(text).toContain(`<tool identifier="${DISCOVERABLE_TOOL}" name="${DISCOVERABLE_TOOL}">`)
  })

  it('lists a tool another plugin registered into the agent scope', async () => {
    const { ctx, makeAgent } = await fixture({ withoutDeclarations: true })
    const { agent } = await makeAgent('agent-scoped-tool')
    await ctx.systemPrompt.assemble({ scope: agent, agent })
    // The agent's own scope is where another plugin puts a per-agent tool:
    // `agent.ctx.tools` needs an inject declaration, so read the service instead.
    const agentTools = (agent.ctx as unknown as { get: (key: string) => { register: (definition: unknown) => () => void } }).get('tools')
    cleanups.push(agentTools.register(defineTool({
      name: AGENT_SCOPED_TOOL,
      description: 'Registered into the agent scope by another plugin',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => `${AGENT_SCOPED_TOOL}:${args.path}`,
    })))
    // The settings page reads the registry's real face: a tool another plugin put
    // into the agent scope has to be listed, or the user can never activate it.
    const remote = (ctx as unknown as { get: (key: string) => { catalog: () => ActivationCatalog } }).get(SETTINGS_REMOTE_NAMESPACE)
    const catalog = remote.catalog()
    expect(catalog.entries.some(entry => entry.tools.includes(AGENT_SCOPED_TOOL))).toBe(true)
  })

  it('hides the un-activated tools on the first read of a restored agent', async () => {
    const { ctx, makeAgent, restored } = await fixture({ withoutDeclarations: true, restoredAgent: true })
    // The host contract is learned from the first scoped assembly; in production
    // the load-time probe already knows it.
    const { agent: probe } = await makeAgent('contract-probe')
    await ctx.systemPrompt.assemble({ scope: probe, agent: probe })
    // A step resolves its tool set before it assembles, so this resolution is the one
    // that has to be narrowed: the agent predates the plugin, so it never saw
    // `agent/created`.
    const admitted = await resolveStep(ctx, restored!.agent)
    expect([...admitted.keys()]).not.toContain(DISCOVERABLE_TOOL)
    // The registry keeps its truth: the tool is registered, only the model may not
    // call it yet. A plugin that registers a per-agent tool reads it back here.
    expect(ctx.tools.schemas(restored!.agent).map(schema => schema.name)).toContain(DISCOVERABLE_TOOL)
  })
})

/**
 * A group is not a stable name for the tools it carries: the user may rename it,
 * split it or delete it while the session runs. The tools the session activated
 * must survive that, so the activation is accounted by tool name.
 */
describe('activation survives a changed group', () => {
  const fileGroup = { identifier: 'files', name: 'Files', description: 'File utilities', tools: ['pwsh', 'web_search'], sections: [] }

  it('keeps the activated tools callable after their group was renamed', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture({ policy: { groups: [fileGroup] } })
    const { agent } = await makeAgent('group-renamed')
    const activated = await call(ctx, agent, 'activate_tools', { identifiers: ['files'], reason: 'Use the file utilities' })
    expect(activated.isError, JSON.stringify(activated)).toBe(false)
    expect(receiptFromContent(activated.content)?.state.activatedTools).toEqual([
      { identifier: 'files', name: 'Files', apiCount: 2, tools: ['pwsh', 'web_search'] },
    ])

    setPolicy({ groups: [{ ...fileGroup, identifier: 'file-tools', name: 'File tools' }] })

    const enabled = await presentation(ctx, agent)
    expect(enabled.names).toEqual(['activate_tools', 'glob', 'grep', 'pwsh', 'read', 'web_search', 'write'])
  })

  it('presents a renamed group as activated under its new identifier', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture({ policy: { groups: [fileGroup] } })
    const { agent } = await makeAgent('group-renamed-presentation')
    await call(ctx, agent, 'activate_tools', { identifiers: ['files'], reason: 'Use the file utilities' })

    setPolicy({ groups: [{ ...fileGroup, identifier: 'file-tools', name: 'File tools' }] })

    const after = await presentation(ctx, agent)
    expect(after.text).toContain('<tool identifier="file-tools" names="pwsh,web_search"/>')
    // Every member is still active, so the directory must not offer the group again.
    expect(after.text).not.toContain('<tool identifier="file-tools" name=')
  })

  it('does not offer the members of a deleted group as unclaimed entries', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture({ policy: { groups: [fileGroup] } })
    const { agent } = await makeAgent('group-deleted-presentation')
    await call(ctx, agent, 'activate_tools', { identifiers: ['files'], reason: 'Use the file utilities' })

    setPolicy({ groups: [] })

    const after = await presentation(ctx, agent)
    expect(after.text).not.toContain('<tool identifier="pwsh" name=')
    expect(after.text).not.toContain('<tool identifier="web_search" name=')
  })

  it('keeps the activated tools callable after their group was split', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture({ policy: { groups: [fileGroup] } })
    const { agent } = await makeAgent('group-split')
    const activated = await call(ctx, agent, 'activate_tools', { identifiers: ['files'], reason: 'Use the file utilities' })
    expect(activated.isError, JSON.stringify(activated)).toBe(false)

    setPolicy({ groups: [{ ...fileGroup, identifier: 'files', tools: ['pwsh'] }, { ...fileGroup, identifier: 'web', name: 'Web', tools: ['web_search'] }] })

    const enabled = await presentation(ctx, agent)
    expect(enabled.names).toEqual(['activate_tools', 'glob', 'grep', 'pwsh', 'read', 'web_search', 'write'])
  })

  it('keeps the activated tools callable after their group was deleted', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture({ policy: { groups: [fileGroup] } })
    const { agent } = await makeAgent('group-deleted')
    const activated = await call(ctx, agent, 'activate_tools', { identifiers: ['files'], reason: 'Use the file utilities' })
    expect(activated.isError, JSON.stringify(activated)).toBe(false)

    setPolicy({ groups: [] })

    const enabled = await presentation(ctx, agent)
    expect(enabled.names).toEqual(['activate_tools', 'glob', 'grep', 'pwsh', 'read', 'web_search', 'write'])
  })

  it('reports a renamed group as already active instead of activating it again', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture({ policy: { groups: [fileGroup] } })
    const { agent } = await makeAgent('group-already-active')
    await call(ctx, agent, 'activate_tools', { identifiers: ['files'], reason: 'Use the file utilities' })

    setPolicy({ groups: [{ ...fileGroup, identifier: 'file-tools', name: 'File tools' }] })

    const again = await call(ctx, agent, 'activate_tools', { identifiers: ['file-tools'], reason: 'Use the file utilities again' })
    expect(receiptFromContent(again.content)?.state).toEqual({
      activatedSkills: [],
      activatedTools: [],
      alreadyActive: ['file-tools'],
      notFound: [],
    })
  })

  it('restores the activated tools of a session whose group was renamed', async () => {
    const { ctx, makeAgent, setPolicy } = await fixture({ policy: { groups: [fileGroup] } })
    const original = await makeAgent('group-source-session')
    await call(ctx, original.agent, 'activate_tools', { identifiers: ['files'], reason: 'Use the file utilities' })
    closeTurn(original.agent.session)
    const serialized: SessionEvent[] = JSON.parse(JSON.stringify(original.events))

    setPolicy({ groups: [{ ...fileGroup, identifier: 'file-tools', name: 'File tools' }] })
    const restored = await makeAgent('group-restored-session', serialized)

    const enabled = await presentation(ctx, restored.agent)
    expect(enabled.names).toEqual(['activate_tools', 'glob', 'grep', 'pwsh', 'read', 'web_search', 'write'])
  })
})

/**
 * The grouping tool is the one tool that reshapes the catalog: it has to be
 * discoverable, callable once it was activated, and honest about the half of
 * its contract that this release does not implement yet.
 */
describe('the grouping tool', () => {
  const fileGroup = { identifier: 'files', name: 'Files', description: 'File utilities', tools: ['pwsh', 'gone'], sections: [] }

  it('is discoverable in the pending catalog and callable once it was activated', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('grouping')
    const directory = await presentation(ctx, agent)
    expect(directory.text).toContain('  <tool identifier="group_tools" name="group_tools">')
    expect(directory.names).not.toContain('group_tools')

    const activated = await call(ctx, agent, 'activate_tools', { identifiers: ['group_tools'], reason: 'Organize the tools' })
    expect(activated.isError, JSON.stringify(activated)).toBe(false)
    expect((await presentation(ctx, agent)).names).toContain('group_tools')

    const listed = await call(ctx, agent, 'group_tools', { action: 'list' }, 'grouping-list')
    expect(listed.isError, JSON.stringify(listed)).toBe(false)
    const value = JSON.parse(resultText(listed.content))
    expect(value.action).toBe('list')
    // The always-loaded tools are addressed as a group of their own, so they head the list.
    expect(value.groups).toHaveLength(1)
    expect(value.groups[0]).toMatchObject({ identifier: 'basic', name: 'Basic tools' })
    expect(value.unclaimed).toEqual(['pwsh', 'web_search'])
    expect(value.basic).toEqual(['ask_user_question', 'edit', 'glob', 'grep', 'read', 'skill', 'todo_write', 'write'])
    expect(value.locked).toEqual(['activate_tools', 'group_tools', 'run_code'])
  })

  it('reports the configured groups with the members that no longer exist', async () => {
    const { ctx, makeAgent } = await fixture({ policy: { groups: [fileGroup] } })
    const { agent } = await makeAgent('grouping-groups')
    await call(ctx, agent, 'activate_tools', { identifiers: ['group_tools'], reason: 'Organize the tools' })

    const listed = await call(ctx, agent, 'group_tools', { action: 'list' }, 'grouping-groups-list')
    expect(listed.isError, JSON.stringify(listed)).toBe(false)
    const value = JSON.parse(resultText(listed.content))
    expect(value.action).toBe('list')
    expect(value.groups.map((group: { identifier: string }) => group.identifier)).toEqual(['basic', 'files'])
    expect(value.groups[1]).toEqual({ identifier: 'files', name: 'Files', description: 'File utilities', tools: [{ name: 'pwsh' }, { name: 'gone', missing: true }] })
    expect(value.unclaimed).toEqual(['web_search'])
    expect(value.basic).toEqual(['ask_user_question', 'edit', 'glob', 'grep', 'read', 'skill', 'todo_write', 'write'])
    expect(value.locked).toEqual(['activate_tools', 'group_tools', 'run_code'])
  })

  it('writes an accepted batch into the host configuration and answers with the receipt', async () => {
    const settings = new FakeSettingsService()
    const { ctx, makeAgent } = await fixture({ settings })
    const { agent } = await makeAgent('grouping-apply-write')
    await call(ctx, agent, 'activate_tools', { identifiers: ['group_tools'], reason: 'Organize the tools' })

    const applied = await call(ctx, agent, 'group_tools', { action: 'apply', ops: [{ op: 'add', identifier: 'new', name: 'New', description: 'A new group', tools: ['pwsh'] }] }, 'grouping-apply-write-call')
    expect(applied.isError, JSON.stringify(applied)).toBe(false)
    expect(JSON.parse(resultText(applied.content))).toEqual({
      action: 'apply',
      receipt: { created: ['new'], updated: [], removed: [], renamed: [], unchanged: [] },
    })
    expect(settings.mutations).toHaveLength(1)
    expect(settings.mutations[0]?.ns).toBe('tool-activator')
    expect(settings.mutations[0]?.expectedRevision).toBe(3)
    expect(settings.mutations[0]?.ops).toEqual([
      { op: 'set', path: ['groups'], value: [{ identifier: 'new', name: 'New', description: 'A new group', tools: ['pwsh'], sections: [] }] },
    ])
  })

  it('renames a group in the host configuration and answers with the rename mapping', async () => {
    const settings = new FakeSettingsService()
    const { ctx, makeAgent } = await fixture({
      settings,
      policy: { groups: [{ identifier: 'files', name: 'Files', description: 'File utilities', tools: ['pwsh'], sections: [] }] },
    })
    const { agent } = await makeAgent('grouping-apply-rename')
    await call(ctx, agent, 'activate_tools', { identifiers: ['group_tools'], reason: 'Organize the tools' })

    const applied = await call(ctx, agent, 'group_tools', { action: 'apply', ops: [{ op: 'update', identifier: 'files', rename: 'file-tools', name: 'File tools' }] }, 'grouping-apply-rename-call')
    expect(applied.isError, JSON.stringify(applied)).toBe(false)
    expect(JSON.parse(resultText(applied.content))).toEqual({
      action: 'apply',
      receipt: { created: [], updated: ['file-tools'], removed: [], renamed: [{ from: 'files', to: 'file-tools' }], unchanged: [] },
    })
    expect(settings.mutations).toHaveLength(1)
    expect(settings.mutations[0]?.ns).toBe('tool-activator')
    expect(settings.mutations[0]?.ops).toEqual([
      { op: 'set', path: ['groups'], value: [{ identifier: 'file-tools', name: 'File tools', description: 'File utilities', tools: ['pwsh'], sections: [] }] },
    ])
  })

  it('reports every problem of a rejected batch and writes nothing', async () => {
    const settings = new FakeSettingsService()
    const { ctx, makeAgent } = await fixture({ settings })
    const { agent } = await makeAgent('grouping-apply-rejected')
    await call(ctx, agent, 'activate_tools', { identifiers: ['group_tools'], reason: 'Organize the tools' })

    const applied = await call(ctx, agent, 'group_tools', { action: 'apply', ops: [{ op: 'add', identifier: 'bad id', tools: [] }] }, 'grouping-apply-rejected-call')
    expect(applied.isError, JSON.stringify(applied)).toBe(false)
    const value = JSON.parse(resultText(applied.content))
    expect(value.action).toBe('apply')
    expect(value.problems.map((problem: { kind: string }) => problem.kind)).toEqual(['invalid-identifier', 'empty-tools'])
    expect(settings.mutations).toEqual([])
  })

  it('refuses an apply with no operation instead of answering with an empty receipt', async () => {
    const settings = new FakeSettingsService()
    const { ctx, makeAgent } = await fixture({ settings })
    const { agent } = await makeAgent('grouping-empty-apply')
    await call(ctx, agent, 'activate_tools', { identifiers: ['group_tools'], reason: 'Organize the tools' })

    const applied = await call(ctx, agent, 'group_tools', { action: 'apply', ops: [] }, 'grouping-empty-apply-call')
    expect(applied.isError).toBe(true)
    expect(applied.error?.message).toContain('needs at least one operation')
    expect(settings.mutations).toEqual([])
  })

  it('refuses to write when the host does not provide a settings service', async () => {
    const { ctx, makeAgent } = await fixture()
    const { agent } = await makeAgent('grouping-apply')
    await call(ctx, agent, 'activate_tools', { identifiers: ['group_tools'], reason: 'Organize the tools' })

    const applied = await call(ctx, agent, 'group_tools', { action: 'apply', ops: [{ op: 'add', identifier: 'new', name: 'New', description: 'A new group', tools: ['pwsh'] }] }, 'grouping-apply-call')
    expect(applied.isError).toBe(true)
    expect(applied.error?.message).toContain('this host does not provide the settings service')
    expect(applied.error?.message).toContain('no change was made')
  })
})
