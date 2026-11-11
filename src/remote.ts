import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolPolicy } from './shared'
import type { ActivationCatalog } from './types'
import { buildToolCatalog } from './catalog'
import { ACTIVATOR_TOOL_NAME, SETTINGS_REMOTE_NAMESPACE } from './constants'
import { DEFAULT_POLICY } from './shared'

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * The settings page reads the live tool catalog from here. The catalog is
 * scope-dependent in general, so the page asks the host instead of guessing
 * from the config document.
 */
export class ToolActivatorRemote {
  constructor(private readonly ctx: Context, private readonly policy: () => ToolPolicy) {}

  /**
   * Every tool this installation can expose. A scope-less read only sees the
   * global registry, so the live agents' scopes are unioned in: those are the
   * tools a session can actually reach.
   */
  private schemas(): ToolSchema[] {
    const byName = new Map<string, ToolSchema>()
    for (const schema of this.ctx.tools.schemas())
      byName.set(schema.name, schema)
    for (const agent of this.agents()) {
      for (const schema of this.ctx.tools.schemas(agent))
        byName.set(schema.name, schema)
    }
    return [...byName.values()]
  }

  private agents(): Agent[] {
    const list = this.ctx.agents.list
    return typeof list === 'function' ? list.call(this.ctx.agents) : []
  }

  catalog(): ActivationCatalog {
    const policy = this.policy()
    const activator: ToolSchema | undefined = this.schemas().find(schema => schema.name === ACTIVATOR_TOOL_NAME)
    return {
      autoGroupMcp: policy.autoGroupMcp,
      basicTools: [...policy.basicTools],
      // Base tools are labelled and sorted first; only the activator stays loaded.
      baseTools: [ACTIVATOR_TOOL_NAME, ...DEFAULT_POLICY.basicTools],
      entries: [
        {
          identifier: ACTIVATOR_TOOL_NAME,
          name: ACTIVATOR_TOOL_NAME,
          description: activator?.description ?? '',
          tools: activator === undefined ? [] : [ACTIVATOR_TOOL_NAME],
        },
        ...buildToolCatalog(this.schemas(), policy).map(entry => ({
          identifier: entry.identifier,
          name: entry.name,
          description: entry.tools.length === 1 ? entry.tools[0]!.description : entry.description,
          tools: entry.tools.map(tool => tool.name),
        })),
      ],
      groups: policy.groups.map(group => ({
        identifier: group.identifier,
        name: group.name,
        description: group.description,
        tools: [...group.tools],
        sections: [...group.sections],
      })),
      requireApproval: policy.requireApproval,
    }
  }
}

export function provideToolActivatorRemote(ctx: Context, policy: () => ToolPolicy): void {
  Object.defineProperty(ToolActivatorRemote.prototype, REMOTE_METHODS, {
    value: Object.freeze({
      version: 1,
      methods: [Object.freeze({ method: 'catalog', invocation: Object.freeze({ kind: 'direct' }) })],
    }),
    enumerable: false,
    configurable: true,
    writable: false,
  })
  const remote = new ToolActivatorRemote(ctx, policy)
  Reflect.set(remote, 'typertRemote', Object.freeze({
    service: remote,
    serviceKey: SETTINGS_REMOTE_NAMESPACE,
    namespace: SETTINGS_REMOTE_NAMESPACE,
  }))
  ctx.provide(SETTINGS_REMOTE_NAMESPACE, remote)
}
