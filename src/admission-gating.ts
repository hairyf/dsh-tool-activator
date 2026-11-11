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

export interface AdmissionGate {
  /** The tools this agent may call in its next step. */
  setAllowed: (agent: Agent, allowed: ReadonlySet<string>) => void
  /**
   * Resolve the allow-list for an agent that has none yet.
   *
   * A step resolves its tool set before it assembles, so the allow-list has to
   * exist before the first resolution — not after an assembly that would
   * install it.
   */
  setResolver: (resolve: (agent: Agent) => void) => void
  /** Forget one agent. */
  forget: (agent: Agent) => void
  /** Put the host's own `resolve` back. */
  restore: () => void
  /** Whether the host exposes the step admission this gate narrows. */
  readonly installed: boolean
}

export interface ToolHiding {
  /**
   * Narrow the next step's admission to the enabled tools.
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
  setGateResolver: (resolve: (agent: Agent) => void) => void
  /** Forget one agent. */
  forget: (agent: Agent) => void
  /** Whether the host exposes the step admission this gate narrows. */
  readonly installed: boolean
}

/** What one sync did, so the caller can report it without a logger. */
export interface HidingResult {
  deny: number
  total: number
  installed: boolean
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
  let resolver: ((agent: Agent) => void) | undefined

  const gate: AdmissionGate = {
    get installed() {
      return true
    },
    setAllowed(agent, next) {
      allowed.set(agent, next)
    },
    setResolver(next) {
      resolver = next
    },
    forget(agent) {
      allowed.delete(agent)
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
      if (agent !== undefined && !allowed.has(agent) && resolver !== undefined)
        resolver(agent)
      const toolSet = await original.call(this, context)
      const allow = agent === undefined ? undefined : allowed.get(agent)
      if (allow === undefined)
        return toolSet
      return {
        dispose: () => toolSet.dispose(),
        view: (scope?: unknown) => {
          const visible = toolSet.view(scope)
          const narrowed = new Map<string, unknown>()
          for (const [name, definition] of visible) {
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
 * The plugin's hiding: narrow the step admission, never the registry.
 *
 * The catalog, the settings page and every other reader of the registry keep
 * seeing the real tool face, so a tool that another plugin registers into an
 * agent stays visible to whoever reads it back.
 */
export function createToolHiding(ctx: Context): ToolHiding {
  const gate = installAdmissionGating(ctx.tools)
  ctx.effect(() => () => gate?.restore())
  return {
    get installed() {
      return gate !== undefined
    },
    sync(agent, catalog, enabled) {
      const names = catalog.flatMap(entry => entry.tools).map(tool => tool.name)
      gate?.setAllowed(agent, enabled)
      return {
        deny: names.filter(name => !enabled.has(name)).length,
        total: names.length,
        installed: gate !== undefined,
      }
    },
    setGateResolver(resolve) {
      gate?.setResolver(resolve)
    },
    forget(agent) {
      gate?.forget(agent)
    },
  }
}
