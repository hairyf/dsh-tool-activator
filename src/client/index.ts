import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ToolActivatorConfiguration } from './configuration-page'
import { CONFIGURATION_ID, CONFIGURATION_PRIORITY, CONFIGURATION_REGISTRANT, CONFIGURATION_SLOT } from './constants'
import { mountToolActivatorStyles } from './styles'

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.effect(mountToolActivatorStyles)
  ctx.slots.inject(CONFIGURATION_SLOT, () => ctx.slots.register({
    name: CONFIGURATION_SLOT,
    key: CONFIGURATION_ID,
    registrant: CONFIGURATION_REGISTRANT,
    priority: CONFIGURATION_PRIORITY,
  }, ToolActivatorConfiguration))
}
