import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ActivationCatalog } from '../types'
import type { ConfigurationScope } from './types'
import { loadToolCatalog } from './catalog'
import { ToolActivatorConfiguration } from './configuration-page'
import { CONFIGURATION_ENTRY_ID, CONFIGURATION_KEY, CONFIGURATION_REGISTRANT, CONFIGURATION_SLOT } from './constants'
import { mountToolActivatorStyles } from './styles'

export const inject = ['slots', 'connection']

/**
 * The configuration lives on this bundle's own page in the Plugins manager, so
 * the page itself owns the settings handle the platform exposes per entry.
 */
export function apply(ctx: Context): void {
  ctx.effect(mountToolActivatorStyles)
  const loadCatalog = (): Promise<ActivationCatalog> => loadToolCatalog(ctx)
  ctx.inject(['configForms'], (branch) => {
    const configScope = branch.configForms.get(CONFIGURATION_ENTRY_ID) as unknown as ConfigurationScope
    branch.slots.inject(CONFIGURATION_SLOT, () => branch.slots.register({
      name: CONFIGURATION_SLOT,
      key: CONFIGURATION_KEY,
      registrant: CONFIGURATION_REGISTRANT,
      inject: () => ({ configScope, loadToolCatalog: loadCatalog }),
    } as never, ToolActivatorConfiguration))
  })
}
