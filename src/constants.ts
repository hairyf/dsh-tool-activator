import type { ContextForm } from '@deepseek-ai/dsh-llm'

export const ACTIVATOR_TOOL_NAME = 'activate_tools'
export const DEACTIVATOR_TOOL_NAME = 'deactivate_tools'
export const RUN_CODE_TOOL_NAME = 'run_code'
export const GROUPING_TOOL_NAME = 'group_tools'
/** Tools no group may ever claim, whatever the configuration says. */
export const LOCKED_TOOL_NAMES: readonly string[] = [ACTIVATOR_TOOL_NAME, DEACTIVATOR_TOOL_NAME, RUN_CODE_TOOL_NAME, GROUPING_TOOL_NAME]
/**
 * The tools that are always in the model's face: the two that manage the
 * catalog and the one that runs the SDK. They are never part of the directory
 * the model activates from, and they are never deferred in the request head.
 */
export const ALWAYS_PRESENT_TOOL_NAMES: readonly string[] = [ACTIVATOR_TOOL_NAME, DEACTIVATOR_TOOL_NAME, RUN_CODE_TOOL_NAME]
/**
 * Why an entry left the session's activated set: the model's own decision, the
 * idle policy, or the cap. The kind is the one vocabulary the reason shares.
 */
export const RELEASE_REASON_KINDS = ['active', 'idle', 'cap'] as const
/**
 * The config schema's identifier pattern; the engine rejects anything it would
 * refuse. The schema and the engine share one pattern, so a group the model
 * writes is always a group the configuration accepts.
 */
export const GROUP_IDENTIFIER_PATTERN: RegExp = /^[\w.-]+$/u
/** A group's description replaces its members' descriptions in the catalog, so it is capped. */
export const GROUP_DESCRIPTION_LIMIT = 120
/**
 * The reserved identifier of the always-loaded tools. The model addresses it as a
 * group so that membership can be edited through the same operations, but the
 * group itself exists in every configuration and cannot be created or deleted.
 */
export const BASIC_GROUP_IDENTIFIER = 'basic'
/**
 * Message source of this plugin's own contributions: the developer messages that
 * declare activated tools and the catalog the model reads about them.
 */
export const ACTIVATOR_SOURCE_KIND = 'tool-activator'

/** The host's own vocabulary for a republished catalog. */
export const CATALOG_FORM = 'catalog' satisfies ContextForm
export const ACTIVATION_PRODUCER = 'dsh-tool-activator'
export const ACTIVATION_VERSION = 1
/**
 * Version of the projected activation state. The wire envelope keeps its own
 * version, so bumping this one only invalidates the persisted projection cache:
 * rows written by an older fold are discarded and recomputed from the session
 * log instead of being applied forward into a state they do not describe.
 */
export const ACTIVATION_STATE_VERSION = 3
export const ACTIVATION_PROJECTION_KEY = 'tool-activator:activation'
export const SETTINGS_REMOTE_NAMESPACE = 'toolActivator'

export const FIRST_PARTY_SECTION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'tool:read': ['read'],
  'tool:write': ['write'],
  'tool:edit': ['edit'],
  'tool:glob': ['glob'],
  'tool:grep': ['grep'],
  'tool:bash': ['bash'],
  'tool:pwsh': ['pwsh'],
  'tool:web_search': ['web_search'],
  'tool:web_fetch': ['web_fetch'],
  'tool:jobs': ['job_output', 'job_list', 'job_kill'],
  'tool:pty': ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'],
  'tool:goal': ['get_goal', 'create_goal', 'update_goal'],
  'tool:session-query': ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read'],
  'tool:lsp': ['lsp'],
  'tool:ralph': ['ralph'],
  'tool:workflow': ['workflow'],
  'tool:structured_output': ['structured_output'],
  'tool:subagent': ['subagent'],
  'tool:subagent_fork': ['subagent_fork'],
}
