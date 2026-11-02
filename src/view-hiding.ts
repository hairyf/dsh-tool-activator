import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * Symbol key shared across plugin instances so two loads never wrap `view` twice.
 *
 * The version suffix is part of the identity: a hook object built by an older
 * build keeps its own (different) filtering contract, so a new build must not
 * adopt it.
 */
const VIEW_HOOK = Symbol.for('dsh-tool-activator.viewHook.v2')

interface FilteredView {
  visible: Map<string, unknown>
  [key: string]: unknown
}

interface ViewHook {
  bypass: number
  descriptor: PropertyDescriptor
  origView: (scope?: unknown) => FilteredView
  /** Names this scope may see; absent means "filter nothing". Read on every call. */
  gateFor?: (scope: unknown) => ReadonlySet<string> | undefined
  wrapped?: (scope?: unknown) => FilteredView
}

export interface ViewHiding {
  /**
   * Allow these names for one agent and hide every other visible tool.
   *
   * The gate is an ALLOW-LIST read on every `view()` call, not a snapshot of
   * what happened to be visible when it was installed: a scope-local tool that
   * registers itself a moment later (the hashline tool set does exactly that
   * from an async agent effect) is hidden on the step that first sees it, with
   * no second turn to catch up.
   */
  /**
   * Run `read` with the gate lifted, then put the SAME gate back.
   *
   * The catalog `activate_tools` offers is read through this: with the gate in
   * place it would report every hidden tool as absent. Restoring the previous
   * gate (rather than leaving none) is what keeps that read from also un-hiding
   * everything for the step that follows it.
   */
  transparent: <T>(agent: Agent, read: () => T) => T
  setGate: (agent: Agent, allowed: ReadonlySet<string>) => void
  /** Stop filtering one agent, so a catalog read sees every tool again. */
  suspend: (agent: Agent) => void
  /** Forget one agent. */
  forget: (agent: Agent) => void
}

/** The tools service as this patch needs it; `view` is not public API. */
interface ToolsHost {
  view?: (scope?: unknown) => FilteredView
  [key: string]: unknown
}
/**
 * Hides tools by wrapping the host's own `tools.view()`.
 *
 * The system prompt declares exactly what `view(scope).visible` holds, so filtering
 * there hides tools on the very first assembly — including agent-scoped registrations
 * that `tools.restrict()` refuses. `view` is not public API: the wrapper keeps the
 * original descriptor so unloading restores the service untouched, and fails closed
 * by returning `undefined` when the host exposes no view to wrap.
 */
export function installViewHiding(tools: unknown): ViewHiding | undefined {
  const service = tools as ToolsHost
  let owner: ToolsHost | undefined = service
  while (owner !== undefined && owner !== null && !Object.hasOwn(owner, 'view'))
    owner = Object.getPrototypeOf(owner) as ToolsHost | undefined
  if (owner === undefined || owner === null || typeof service.view !== 'function')
    return undefined

  const hook = ensureHook(owner)
  if (hook === undefined)
    return undefined

  const gates = new WeakMap<Agent, ReadonlySet<string>>()
  hook.gateFor = scope => (scope instanceof Object ? gates.get(scope as Agent) : undefined)

  return {
    setGate(agent, allowed) {
      gates.set(agent, new Set(allowed))
    },
    suspend(agent) {
      gates.delete(agent)
    },
    transparent(agent, read) {
      const previous = gates.get(agent)
      gates.delete(agent)
      try {
        return read()
      }
      finally {
        if (previous !== undefined)
          gates.set(agent, previous)
      }
    },
    forget(agent) {
      gates.delete(agent)
    },
  }
}

function ensureHook(owner: ToolsHost): ViewHook | undefined {
  const existing = (owner as unknown as Record<symbol, unknown>)[VIEW_HOOK]
  if (existing !== undefined)
    return existing as ViewHook

  const descriptor = Object.getOwnPropertyDescriptor(owner, 'view')
  const origView = owner.view
  if (descriptor === undefined || typeof origView !== 'function')
    return undefined

  const hook: ViewHook = { bypass: 0, descriptor, origView }
  // The wrapper copies the visible map before editing it: the host hands the same
  // service-wide map to every caller, so mutating it in place would leak into scopes
  // this plugin does not own.
  hook.wrapped = function (this: unknown, scope?: unknown): FilteredView {
    const original = hook.origView.call(this, scope)
    // Hosts this plugin still supports (0.2.0 / 0.2.1) hand the waterfall its own
    // declarations, so no gate is ever installed there — but they call through
    // here too. An unfamiliar view shape has to pass through untouched instead of
    // turning every tool lookup into a TypeError.
    if (!(original?.visible instanceof Map))
      return original
    const copy: FilteredView = { ...original, visible: new Map(original.visible) }
    if (hook.bypass > 0)
      return copy
    const allowed = hook.gateFor?.(scope)
    if (allowed !== undefined) {
      // Walk a copy of the keys: a gate that grows while we iterate (a dynamic
      // allow-list) would otherwise skip names.
      for (const name of [...copy.visible.keys()]) {
        if (!allowed.has(name))
          copy.visible.delete(name)
      }
    }
    return copy
  }
  Object.defineProperty(owner, VIEW_HOOK, { configurable: true, enumerable: false, value: hook, writable: true })
  Object.defineProperty(owner, 'view', { ...descriptor, value: hook.wrapped })
  return hook
}
