import type { Context } from '@deepseek-ai/cordis'
import type { ToolPolicy } from './shared'
import type { ActivationCatalog } from './types'
import { buildToolCatalog } from './catalog'
import { SETTINGS_REMOTE_NAMESPACE } from './constants'

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * The settings page reads the live tool catalog from here. The catalog is
 * scope-dependent in general, so the page asks the host instead of guessing
 * from the config document.
 */
export class ToolActivatorRemote {
  constructor(private readonly ctx: Context, private readonly policy: () => ToolPolicy) {}

  catalog(): ActivationCatalog {
    const policy = this.policy()
    return {
      enabled: policy.enabled,
      basicTools: [...policy.basicTools],
      entries: buildToolCatalog(this.ctx.tools.schemas(), policy).map(entry => ({
        identifier: entry.identifier,
        name: entry.name,
        description: entry.description,
        tools: entry.tools.map(tool => tool.name),
      })),
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
