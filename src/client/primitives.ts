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
  Checkbox?: ComponentType<CheckboxProps>
  Input?: ComponentType<InputProps>
  Switch?: ComponentType<SwitchProps>
  Tag?: ComponentType<TagProps>
  Tooltip?: ComponentType<TooltipProps>
}

export interface ButtonProps {
  children?: ReactNode
  className?: string
  disabled?: boolean
  onClick?: () => void
  size?: 'md' | 'sm'
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
}

export interface CheckboxProps {
  checked: boolean
  className?: string
  disabled?: boolean
  label: string
  title?: string
  onChange: (next: boolean) => void
}

export interface InputProps {
  className?: string
  disabled?: boolean
  placeholder?: string
  value: string
  onValueChange: (next: string) => void
}

export interface TooltipProps {
  children?: ReactNode
  label: string
  side?: 'right' | 'bottom' | 'top'
}

export interface TagProps {
  children?: ReactNode
  className?: string
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
}

const BUTTON_CAPABILITY = 'Button'
const CHECKBOX_CAPABILITY = 'Checkbox'
const INPUT_CAPABILITY = 'Input'
const SWITCH_CAPABILITY = 'Switch'
const TAG_CAPABILITY = 'Tag'
const TOOLTIP_CAPABILITY = 'Tooltip'

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

function LocalButton({ children, disabled, onClick, variant }: ButtonProps): ReactElement {
  const classes = ['dsh-tool-activator-button']
  if (variant !== undefined)
    classes.push(`dsh-tool-activator-button-${variant}`)
  return createElement('button', {
    className: classes.join(' '),
    disabled: disabled === true,
    onClick,
    type: 'button',
  }, children)
}

/** What the official input needs; the wrapper adapts its own value/callback API to it. */
interface OfficialInputProps {
  className?: string
  disabled?: boolean
  onChange?: (event: { target: { value: string } }) => void
  placeholder?: string
  value?: string
}

/** The official input is a native input with the kit's classes; only the plumbing differs. */
function OfficialInput({ className, disabled, placeholder, value, onValueChange }: InputProps): ReactElement {
  const Input = primitive<OfficialInputProps>(INPUT_CAPABILITY)!
  return createElement(Input, {
    className,
    disabled: disabled === true,
    onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
    placeholder,
    value,
  })
}

function LocalInput({ className, disabled, placeholder, value, onValueChange }: InputProps): ReactElement {
  return createElement('input', {
    className: className === undefined ? 'dsh-tool-activator-input' : `dsh-tool-activator-input ${className}`,
    disabled: disabled === true,
    onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
    placeholder,
    value,
  })
}

/** A missing Tooltip keeps the label reachable as native hover text. */
function LocalTooltip({ children, label }: TooltipProps): ReactElement {
  return createElement('span', { className: 'dsh-tool-activator-tooltip-anchor', title: label }, children)
}

function LocalCheckbox({ checked, className, disabled, label, title, onChange }: CheckboxProps): ReactElement {
  return createElement('label', {
    className: className === undefined ? 'dsh-tool-activator-checkbox' : `dsh-tool-activator-checkbox ${className}`,
    title,
  }, createElement('input', {
    checked,
    disabled: disabled === true,
    onChange: (event: { target: { checked: boolean } }) => onChange(event.target.checked),
    type: 'checkbox',
  }), createElement('span', undefined, label))
}

const officialInput = primitive<InputProps>(INPUT_CAPABILITY)
const officialTooltip = primitive<TooltipProps>(TOOLTIP_CAPABILITY)

export const ToolActivatorButton: ComponentType<ButtonProps> = primitive<ButtonProps>(BUTTON_CAPABILITY) ?? LocalButton
export const ToolActivatorCheckbox: ComponentType<CheckboxProps> = primitive<CheckboxProps>(CHECKBOX_CAPABILITY) ?? LocalCheckbox
export const ToolActivatorInput: ComponentType<InputProps> = officialInput === undefined ? LocalInput : OfficialInput
export const ToolActivatorSwitch: ComponentType<SwitchProps> = primitiveSwitch() ?? LocalSwitch
export const ToolActivatorTag: ComponentType<TagProps> = primitive<TagProps>(TAG_CAPABILITY) ?? LocalTag
export const ToolActivatorTooltip: ComponentType<TooltipProps> = officialTooltip ?? LocalTooltip
