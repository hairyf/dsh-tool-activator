import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCatalogItem } from './types'

/**
 * The host's step admission: the tools one step is allowed to call. Only the
 * shape this plugin needs — the host owns the real type, and 0.2.0-rc.2 has no
 * admission at all.
 */
interface ResolvedToolSetLike {
  dispose: () => void
  view: (scope?: unknown) => ReadonlyMap<string, unknown>
}

interface ToolActivationContextLike {
  agent?: Agent
}

/** The tools service as this gate needs it; `resolve` is public since 0.2.2. */
interface ToolsHost {
  resolve?: (context: ToolActivationContextLike) => Promise<ResolvedToolSetLike>
  [key: string]: unknown
}

/**
 * How an inactive tool leaves the model's face.
 *
 * `filter` removes it from the step admission, which removes it from the
 * provider-owned declaration list as well — the request head changes on every
 * activation, and the provider's cached prefix with it. `defer` keeps every
 * definition in place and marks the inactive ones `deferLoading`, so the
 * declaration list never changes; the host then makes an entry callable through
 * a mid-conversation `tool_addition` instead.
 */
export type AdmissionMode = 'filter' | 'defer'

export interface AdmissionGate {
  /** The tools this agent may call in its next step. */
  setAllowed: (agent: Agent, allowed: ReadonlySet<string>) => void
  /** How inactive tools are presented for one agent. */
  setMode: (agent: Agent, mode: AdmissionMode) => void
  /**
   * The names declared without deferral, whatever the session activated.
   *
   * The declaration an activation would rewrite is the whole cost this gate
   * avoids: a deferred tool stays deferred after it is activated, and the
   * mid-conversation `tool_addition` is what makes it callable. Only the tools
   * that are always in the model's face are declared immediate, so the list is a
   * function of the configuration — never of the session.
   */
  setImmediate: (agent: Agent, names: ReadonlySet<string>) => void
  /**
   * Resolve the allow-list for an agent that has none yet.
   *
   * A step resolves its tool set before it assembles, so the allow-list has to
   * exist before the first resolution — not after an assembly that would
   * install it.
   */
  setResolver: (resolve: (agent: Agent) => void | Promise<void>) => void
  /** Forget one agent. */
  forget: (agent: Agent) => void
  /** Put the host's own `resolve` back. */
  restore: () => void
  /** Whether the host exposes the step admission this gate narrows. */
  readonly installed: boolean
}

export interface ToolHiding {
  /**
   * Present the tools this plugin enabled, in the mode the agent's route can
   * carry.
   *
   * The registry view stays untouched on purpose: `tools.schemas(scope)` is the
   * scope's real tool face, and every reader of it — this plugin's settings
   * page, a plugin that probes its own registration, the host's own plugins —
   * must see what is really registered. Filtering there made a plugin that
   * registers a per-agent tool read its own registration back as missing, and
   * it withdraw the registration it had just made.
   */
  sync: (agent: Agent, catalog: readonly ToolCatalogItem[], enabled: ReadonlySet<string>) => HidingResult
  /** Resolve the allow-list for an agent that has none yet. */
  setGateResolver: (resolve: (agent: Agent) => void | Promise<void>) => void
  /** Present this agent's inactive tools in the given mode. */
  setMode: (agent: Agent, mode: AdmissionMode) => void
  /** The names declared without deferral, whatever the session activated. */
  setImmediate: (agent: Agent, names: ReadonlySet<string>) => void
  /** Forget one agent. */
  forget: (agent: Agent) => void
  /** Whether the host exposes the step admission this gate narrows. */
  readonly installed: boolean
}

/** What one sync did, so the caller can report it without a logger. */
export interface HidingResult {
  /** Inactive tools the gate keeps out of the model's reach. */
  deny: number
  total: number
  installed: boolean
  mode: AdmissionMode
}

/**
 * The same definition with deferred loading requested.
 *
 * The host copies this flag into the declaration it merges after the prompt
 * waterfall (`projectToolSchema`), which is the one place this plugin can still
 * reach the request head on dsh >= 0.2.2.
 */
function deferred(definition: unknown): unknown {
  const tool = definition as { deferLoading?: boolean }
  if (tool === null || typeof tool !== 'object' || tool.deferLoading === true)
    return definition
  return { ...(definition as Record<string, unknown>), deferLoading: true }
}

/**
 * Narrows the host's step admission to the tools this plugin enabled.
 *
 * Returns `undefined` on hosts without an admission contract (0.2.0-rc.2 and
 * 0.2.1): those hosts hand the tool declarations to the prompt assembly, and
 * the assembly is where the hiding happens there.
 */
export function installAdmissionGating(tools: unknown): AdmissionGate | undefined {
  const service = tools as ToolsHost
  let owner: ToolsHost | undefined = service
  while (owner !== undefined && owner !== null && !Object.hasOwn(owner, 'resolve'))
    owner = Object.getPrototypeOf(owner) as ToolsHost | undefined
  if (owner === undefined || owner === null || typeof owner.resolve !== 'function')
    return undefined

  const original = owner.resolve
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'resolve')
  const allowed = new WeakMap<Agent, ReadonlySet<string>>()
  const modes = new WeakMap<Agent, AdmissionMode>()
  const immediate = new WeakMap<Agent, ReadonlySet<string>>()
  let resolver: ((agent: Agent) => void | Promise<void>) | undefined

  const gate: AdmissionGate = {
    get installed() {
      return true
    },
    setAllowed(agent, next) {
      allowed.set(agent, next)
    },
    setMode(agent, mode) {
      modes.set(agent, mode)
    },
    setImmediate(agent, names) {
      immediate.set(agent, names)
    },
    setResolver(next) {
      resolver = next
    },
    forget(agent) {
      allowed.delete(agent)
      modes.delete(agent)
      immediate.delete(agent)
    },
    restore() {
      if (descriptor === undefined)
        Reflect.deleteProperty(owner as ToolsHost, 'resolve')
      else
        Object.defineProperty(owner as ToolsHost, 'resolve', descriptor)
    },
  }

  Object.defineProperty(owner, 'resolve', {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
    async value(this: unknown, context: ToolActivationContextLike): Promise<ResolvedToolSetLike> {
      const agent = context.agent
      // The presentation has to be decided before the host derives this step's
      // declarations from it: deciding it one step later would change the head
      // once, which is the whole cost this gate exists to avoid.
      if (agent !== undefined && !allowed.has(agent) && resolver !== undefined)
        await resolver(agent)
      const toolSet = await original.call(this, context)
      const allow = agent === undefined ? undefined : allowed.get(agent)
      if (allow === undefined)
        return toolSet
      const mode = agent === undefined ? 'filter' : modes.get(agent) ?? 'filter'
      const kept = agent === undefined ? undefined : immediate.get(agent)
      return {
        dispose: () => toolSet.dispose(),
        view: (scope?: unknown) => {
          const visible = toolSet.view(scope)
          const narrowed = new Map<string, unknown>()
          for (const [name, definition] of visible) {
            if (mode === 'defer') {
              // Deferral is a property of the configuration, not of the session:
              // activating a tool must leave this map byte-identical, or the host
              // logs a new request header and the cached prefix is lost.
              narrowed.set(name, kept?.has(name) === true ? definition : deferred(definition))
              continue
            }
            if (allow.has(name))
              narrowed.set(name, definition)
          }
          return narrowed
        },
      }
    },
  })

  return gate
}

/**
 * The plugin's hiding: present the step admission, never rewrite the registry.
 *
 * The catalog, the settings page and every other reader of the registry keep
 * seeing the real tool face, so a tool that another plugin registers into an
 * agent stays visible to whoever reads it back.
 */
export function createToolHiding(ctx: Context): ToolHiding {
  const gate = installAdmissionGating(ctx.tools)
  ctx.effect(() => () => gate?.restore())
  const modes = new WeakMap<Agent, AdmissionMode>()
  const immediate = new WeakMap<Agent, ReadonlySet<string>>()
  return {
    get installed() {
      return gate !== undefined
    },
    sync(agent, catalog, enabled) {
      const names = catalog.flatMap(entry => entry.tools).map(tool => tool.name)
      const mode = modes.get(agent) ?? 'filter'
      gate?.setAllowed(agent, enabled)
      gate?.setMode(agent, mode)
      gate?.setImmediate(agent, immediate.get(agent) ?? new Set())
      return {
        deny: names.filter(name => !enabled.has(name)).length,
        total: names.length,
        installed: gate !== undefined,
        mode,
      }
    },
    setGateResolver(resolve) {
      gate?.setResolver(resolve)
    },
    setMode(agent, mode) {
      modes.set(agent, mode)
    },
    setImmediate(agent, names) {
      immediate.set(agent, names)
    },
    forget(agent) {
      modes.delete(agent)
      immediate.delete(agent)
      gate?.forget(agent)
    },
  }
}
