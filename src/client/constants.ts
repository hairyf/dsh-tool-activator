import { CONFIG_ROW_ID, PACKAGE_NAME } from '../shared'

export const CONFIGURATION_SLOT = 'plugins.row.config'
export const CONFIGURATION_ID = `${PACKAGE_NAME}#${CONFIG_ROW_ID}`
export const CONFIGURATION_REGISTRANT = PACKAGE_NAME
export const CONFIGURATION_PRIORITY = 0
export const STYLE_ID = 'dsh-tool-activator-configuration'
export const TOOL_NAME_PATTERN = /^[\w.-]+$/u
export const GROUP_FIELDS = new Set(['identifier', 'name', 'description', 'tools', 'sections'])

export const CLASSES = {
  root: 'dsh-tool-activator-config',
  header: 'dsh-tool-activator-header',
  title: 'dsh-tool-activator-title',
  description: 'dsh-tool-activator-description',
  notice: 'dsh-tool-activator-notice',
  error: 'dsh-tool-activator-error',
  success: 'dsh-tool-activator-success',
  fields: 'dsh-tool-activator-fields',
  field: 'dsh-tool-activator-field',
  checkbox: 'dsh-tool-activator-checkbox',
  help: 'dsh-tool-activator-help',
  actions: 'dsh-tool-activator-actions',
  advanced: 'dsh-tool-activator-advanced',
  version: 'dsh-tool-activator-version',
  icon: 'dsh-tool-activator-icon',
} as const
