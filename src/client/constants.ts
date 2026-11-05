import { CONFIG_ROW_ID, PACKAGE_NAME } from '../shared'

export const CONFIGURATION_SLOT = 'plugins.bundle.config'
export const CONFIGURATION_KEY = PACKAGE_NAME
export const CONFIGURATION_REGISTRANT = PACKAGE_NAME
export const CONFIGURATION_ENTRY_ID = CONFIG_ROW_ID
export const STYLE_TAG_ID = 'dsh-tool-activator/config.css'

/** The config schema's rule for `groups[].identifier`; the page gates Host writes on it. */
export const GROUP_IDENTIFIER_PATTERN = /^[\w.-]+$/u

/** How long a group edit settles before it is persisted, so typing stays responsive. */
export const GROUPS_WRITE_DELAY_MS = 500
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
  setting: 'dsh-tool-activator-setting',
  settingIcon: 'dsh-tool-activator-setting-icon',
  group: 'dsh-tool-activator-group',
  groups: 'dsh-tool-activator-groups',
  groupHeader: 'dsh-tool-activator-group-header',
  groupBody: 'dsh-tool-activator-group-body',
  field: 'dsh-tool-activator-field',
  fieldLabel: 'dsh-tool-activator-field-label',
  fieldWide: 'dsh-tool-activator-field-wide',
  choices: 'dsh-tool-activator-choices',
  choice: 'dsh-tool-activator-choice',
  toolbar: 'dsh-tool-activator-toolbar',
  collapsible: 'dsh-tool-activator-collapsible',
  collapsibleHeader: 'dsh-tool-activator-collapsible-header',
  collapsibleToggle: 'dsh-tool-activator-collapsible-toggle',
  collapsibleLabel: 'dsh-tool-activator-collapsible-label',
  collapsibleChevron: 'dsh-tool-activator-collapsible-chevron',
  collapsibleActions: 'dsh-tool-activator-collapsible-actions',
  collapsibleBody: 'dsh-tool-activator-collapsible-body',
  groupFilter: 'dsh-tool-activator-group-filter',
} as const
