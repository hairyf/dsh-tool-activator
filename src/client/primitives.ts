import type { ComponentType, ReactElement } from 'react'
import { createElement } from 'react'

export interface SwitchProps {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}

interface PrimitivesModule {
  Switch?: ComponentType<SwitchProps>
}

const SWITCH_CAPABILITY = 'Switch'

/**
 * The platform seeds its shared UI kit, but a host that does not must not brick
 * this plugin: the official control is preferred and the local one below copies
 * its markup and rules.
 */
function primitiveSwitch(): ComponentType<SwitchProps> | undefined {
  try {
    // eslint-disable-next-line ts/no-require-imports -- the client bundle is lazy CJS and the platform seeds this module; a static import would brick the whole bundle on a host that omits it
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as PrimitivesModule
    return typeof primitives?.[SWITCH_CAPABILITY] === 'function' ? primitives[SWITCH_CAPABILITY] : undefined
  }
  catch {
    return undefined
  }
}

function LocalSwitch({ checked, disabled, label, onChange }: SwitchProps): ReactElement {
  return createElement('button', {
    'aria-checked': checked,
    'aria-label': label,
    'className': 'dsh-tool-activator-switch',
    'disabled': disabled === true,
    'onClick': () => onChange(!checked),
    'role': 'switch',
    'type': 'button',
  }, createElement('span', { className: 'dsh-tool-activator-switch-thumb' }))
}

export const ToolActivatorSwitch: ComponentType<SwitchProps> = primitiveSwitch() ?? LocalSwitch
