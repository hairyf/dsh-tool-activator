import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCatalogItem } from './types'
import type { ViewHiding } from './view-hiding'
import { installViewHiding } from './view-hiding'

interface HidingState {
  restriction?: () => void
  signature?: string
  warned: boolean
  applied?: number
}

export interface ToolHiding {
  /**
   * Hide every catalog tool that is not enabled yet. Recomputed from the catalog on
   * each call, and an unchanged set leaves the installed restriction in place.
   */
  sync: (agent: Agent, catalog: readonly ToolCatalogItem[], enabled: ReadonlySet<string>) => HidingResult
  /** Lift this agent's restriction and forget its state. */
  forget: (agent: Agent) => void
  /**
   * Read something that MUST see every tool — the catalog above all — with the
   * hiding gate lifted for exactly the length of the read.
   *
   * `activate_tools` builds its directory from `tools.schemas(agent)`, so a gate
   * left installed makes the plugin blind to the very tools it offers: every
   * activation would answer `Not found`. The gate goes back afterwards, because
   * leaving it off would declare every tool on the next step.
   */
  readAll: <T>(agent: Agent, read: () => T) => T
  /** Drop the installed restriction so the next catalog read sees every tool. */
  suspend: (agent: Agent) => void
  /**
   * Install the gate resolver. It exists because a step resolves its tool set
   * before the assembly hook runs, so an agent that predates this load would
   * otherwise declare every tool on its first step.
   */
  setGateResolver: (resolve: (agent: Agent) => void) => void
}

/** What one sync did, so the caller can report it without a logger. */
export interface HidingResult {
  deny: number
  total: number
  installed: boolean
  error?: string
}

/**
 * Hides tool declarations on hosts that own them. From dsh 0.2.2 the assembly
 * waterfall receives a presentation without `tools` and the provider merges the
 * schemas afterwards, so rewriting the assembly hides nothing. The scoped
 * restriction is what remains: it removes the tools from one agent's model
 * surface *and* from its callable set, which is exactly what an un-activated tool
 * should be — discoverable through the directory, not declared.
 */
export function createToolHiding(ctx: Context): ToolHiding {
  const states = new WeakMap<Agent, HidingState>()
  // Filtering the host's view hides agent-scoped registrations too and takes effect
  // on the first assembly; `restrict` stays as the fallback when no view is wrapable.
  const viewHiding: ViewHiding | undefined = installViewHiding(ctx.tools)
  if (viewHiding === undefined) {
    // Worth saying out loud: it is the difference between hiding agent-scoped tools
    // (hashline's, for one) and leaving them declared no matter what the user
    // activates, and no later symptom names this cause.
    console.warn('[dsh-tool-activator] host exposes no wrapable tools.view(); hiding falls back to a scoped restriction, which cannot hide tools registered into the agent\'s own scope')
  }

  function stateOf(agent: Agent): HidingState {
    const existing = states.get(agent)
    if (existing !== undefined)
      return existing
    const created: HidingState = { warned: false }
    states.set(agent, created)
    return created
  }

  interface RestrictionAttempt {
    lift?: () => void
    deny: number
    error?: string
  }

  /**
   * The host refuses the whole mask over one scope-local name, but names the
   * offenders; drop them and retry until it accepts what it can restrict.
   */
  function applyRestriction(agent: Agent, candidates: readonly string[]): RestrictionAttempt {
    let pending = [...candidates]
    for (let attempt = 0; attempt < 8 && pending.length > 0; attempt += 1) {
      try {
        return { lift: agent.ctx.tools.restrict({ deny: pending }), deny: pending.length }
      }
      catch (problem) {
        const message = problem instanceof Error ? problem.message : String(problem)
        const listed = /unknown global tools? (.*?); known global tools/u.exec(message)?.[1]
        const rejected = listed === undefined
          ? []
          : [...listed.matchAll(/"([^"]+)"/gu)].map(match => match[1]!)
        if (rejected.length === 0)
          return { deny: pending.length, error: message }
        const drop = new Set(rejected)
        const next = pending.filter(name => !drop.has(name))
        if (next.length === pending.length)
          return { deny: pending.length, error: message }
        pending = next
      }
    }
    return { deny: pending.length, error: pending.length === 0 ? 'no restrictable tools' : 'restriction refused' }
  }
  return {
    sync(agent, catalog, enabled) {
      const state = stateOf(agent)
      const names = catalog
        .flatMap(entry => entry.tools)
        .map(tool => tool.name)
      // Every not-enabled name is a candidate; the host rejects the scope-local
      // ones by name and applyRestriction drops them, so nothing is lost here.
      if (viewHiding !== undefined) {
        // The gate is the allow-list itself, not the complement of what the catalog
        // happened to hold when this ran: a scope-local tool that registers a moment
        // later (an async agent effect) is outside `enabled` and stays hidden on the
        // step that first sees it instead of leaking until the next assembly.
        viewHiding.setGate(agent, enabled)
        const hiddenNames = names.filter(name => !enabled.has(name))
        return { deny: hiddenNames.length, total: names.length, installed: true }
      }
      const candidates = names.filter(name => !enabled.has(name))
      const signature = candidates.join('\u0000')
      if (signature === state.signature)
        return { deny: state.applied ?? candidates.length, total: names.length, installed: state.restriction !== undefined }
      state.restriction?.()
      state.restriction = undefined
      state.signature = signature
      if (candidates.length === 0)
        return { deny: 0, total: names.length, installed: false }
      const applied = applyRestriction(agent, candidates)
      state.applied = applied.deny
      if (applied.lift !== undefined) {
        state.restriction = applied.lift
        return { deny: applied.deny, total: names.length, installed: true }
      }
      if (!state.warned) {
        state.warned = true
        console.warn(`[dsh-tool-activator] cannot hide inactive tools with a scoped restriction: ${applied.error ?? 'unknown error'}`)
      }
      return { deny: applied.deny, total: names.length, installed: false, error: applied.error }
    },
    setGateResolver(resolve) {
      viewHiding?.setGateResolver(resolve)
    },
    readAll(agent, read) {
      if (viewHiding !== undefined)
        return viewHiding.transparent(agent, read)
      // Restriction path: the mask hides the same tools from the catalog, so lift
      // it for the read. Clearing the signature is what makes the caller's next
      // `sync` install it again instead of trusting the disposed one.
      const state = states.get(agent)
      if (state === undefined)
        return read()
      const lift = state.restriction
      state.restriction = undefined
      state.signature = undefined
      try {
        return read()
      }
      finally {
        lift?.()
      }
    },
    suspend(agent) {
      viewHiding?.suspend(agent)
      const state = states.get(agent)
      if (state === undefined)
        return
      state.restriction?.()
      state.restriction = undefined
      state.signature = undefined
    },
    forget(agent) {
      viewHiding?.forget(agent)
      const state = states.get(agent)
      if (state === undefined)
        return
      state.restriction?.()
      states.delete(agent)
    },
  }
}
