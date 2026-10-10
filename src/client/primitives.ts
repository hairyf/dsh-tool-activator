import type { ComponentType, ReactElement, ReactNode } from 'react'
import { createElement } from 'react'

export interface SwitchProps {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}

interface PrimitivesModule {
  Button?: ComponentType<ButtonProps>
  Switch?: ComponentType<SwitchProps>
  Tag?: ComponentType<TagProps>
}

export interface ButtonProps {
  children?: ReactNode
  className?: string
  disabled?: boolean
  onClick?: () => void
  size?: 'md' | 'sm'
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
}

export interface TagProps {
  children?: ReactNode
  className?: string
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
}

const BUTTON_CAPABILITY = 'Button'
const SWITCH_CAPABILITY = 'Switch'
const TAG_CAPABILITY = 'Tag'

/**
 * The platform seeds its shared UI kit, but a host that does not must not brick
 * this plugin: the official control is preferred and the local one below copies
 * its markup and rules.
 */
function primitiveSwitch(): ComponentType<SwitchProps> | undefined {
  return primitive<SwitchProps>(SWITCH_CAPABILITY)
}

function primitive<T>(capability: keyof PrimitivesModule): ComponentType<T> | undefined {
  try {
    // eslint-disable-next-line ts/no-require-imports -- the client bundle is lazy CJS and the platform seeds this module; a static import would brick the whole bundle on a host that omits it
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as PrimitivesModule
    const candidate = primitives?.[capability]
    return typeof candidate === 'function' ? candidate as ComponentType<T> : undefined
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

function LocalTag({ children, className }: TagProps): ReactElement {
  return createElement('span', { className: className === undefined ? 'dsh-tool-activator-chip' : `dsh-tool-activator-chip ${className}` }, children)
}

function LocalButton({ children, disabled, onClick }: ButtonProps): ReactElement {
  return createElement('button', {
    className: 'dsh-tool-activator-button',
    disabled: disabled === true,
    onClick,
    type: 'button',
  }, children)
}

export const ToolActivatorButton: ComponentType<ButtonProps> = primitive<ButtonProps>(BUTTON_CAPABILITY) ?? LocalButton
export const ToolActivatorSwitch: ComponentType<SwitchProps> = primitiveSwitch() ?? LocalSwitch
export const ToolActivatorTag: ComponentType<TagProps> = primitive<TagProps>(TAG_CAPABILITY) ?? LocalTag
