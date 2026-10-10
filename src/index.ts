import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolActivatorConfig } from './config'
import { validatePolicy } from './config'
import { installToolActivator } from './host'
import { MINIMUM_CORE_VERSION } from './shared'

export { Config } from './config'
export const name = 'tool-activator'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessionProjections']

export function apply(ctx: Context, config: ToolActivatorConfig): void {
  validatePolicy(config.get())
  if (
    typeof ctx.tools.schemas !== 'function'
    || typeof ctx.tools.get !== 'function'
    || typeof ctx.tools.register !== 'function'
    || typeof ctx.tools.execute !== 'function'
    || typeof ctx.systemPrompt.context !== 'function'
    || typeof ctx.systemPrompt.variable !== 'function'
    || typeof ctx.agents.get !== 'function'
    || typeof ctx.sessionProjections.register !== 'function'
    || typeof ctx.sessionProjections.stateOf !== 'function'
  ) {
    throw new TypeError(`dsh-tool-activator requires core >=${MINIMUM_CORE_VERSION} and its public tools, prompt, agent, and session-projection APIs`)
  }
  installToolActivator(ctx, config)
}
