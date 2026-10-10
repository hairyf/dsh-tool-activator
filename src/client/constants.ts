import { CONFIG_ROW_ID, PACKAGE_NAME } from '../shared'

export const CONFIGURATION_SLOT = 'plugins.bundle.config'
export const CONFIGURATION_KEY = PACKAGE_NAME
export const CONFIGURATION_REGISTRANT = PACKAGE_NAME
export const CONFIGURATION_ENTRY_ID = CONFIG_ROW_ID
export const STYLE_TAG_ID = 'dsh-tool-activator/config.css'
export const TOOL_ACTIVATOR_REMOTE = 'toolActivator'

export const CLASSES = {
  root: 'dsh-tool-activator-config',
  header: 'dsh-tool-activator-header',
  title: 'dsh-tool-activator-title',
  description: 'dsh-tool-activator-description',
  notice: 'dsh-tool-activator-notice',
  error: 'dsh-tool-activator-error',
  success: 'dsh-tool-activator-success',
  section: 'dsh-tool-activator-section',
  sectionTitle: 'dsh-tool-activator-section-title',
  list: 'dsh-tool-activator-list',
  row: 'dsh-tool-activator-row',
  rowText: 'dsh-tool-activator-row-text',
  rowName: 'dsh-tool-activator-row-name',
  rowMeta: 'dsh-tool-activator-row-meta',
  help: 'dsh-tool-activator-help',
} as const
