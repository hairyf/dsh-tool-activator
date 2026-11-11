import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { RELEASE_REASON_KINDS } from './constants'
import type { ToolGroup, ToolPolicy } from './shared'

/** One entry of the tool catalog: what the model can still activate. */
export interface CatalogEntry {
  /** The identifier the model activates by. */
  name: string
  /** What this entry covers, in one line. */
  description: string
  /** Member names this entry carries, so a republication can name what left it. */
  tools: string[]
}

/** One publication of the tool catalog. */
export interface CatalogPublication {
  /** The model-facing text of the whole catalog. */
  text: string
  /** The entries still available in this session, in catalog order. */
  entries: readonly CatalogEntry[]
  /**
   * 全量目录的成员表（含已激活条目）。publisher 用它判定「消失」：条目只是
   * 被激活而离开可选目录时，它还在这里，不会被误报成已卸载。
   */
  members: readonly CatalogEntry[]
  /** The entries this session released since the last publication. */
  released?: readonly ReleasedEntry[]
}

/**
 * The source of this plugin's own messages: the developer message that
 * declares an activated tool, and the catalog the model reads.
 *
 * The catalog form carries the entries it published, so a consumer presents
 * the list instead of re-parsing the prose, and marks a replacement catalog so
 * the consumer knows the earlier one no longer applies.
 */
export type ActivatorMessageSource
  = | { readonly kind: 'tool-activator' }
    | {
      readonly kind: 'tool-activator'
      readonly form: 'catalog'
      readonly entries: readonly CatalogEntry[]
      /** 全量成员表，供下一次发布判定「已消失」。 */
      readonly members?: readonly CatalogEntry[]
      /** The entries this session released, so a consumer can show what left the set. */
      readonly released?: readonly ReleasedEntry[]
      readonly update?: true
    }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-activator': ActivatorMessageSource
  }
}

/** The system prompt assembly and the catalog this plugin publishes beside it. */
export interface PreparedPrompt {
  /** The assembly with the tool-dependent sections removed: they travel with the catalog. */
  assembly: AssembledPrompt
  /** The catalog the model reads about the tools it may call. */
  catalog: CatalogPublication
}

/** Publishes the tool catalog as this plugin's own message. */
export interface CatalogPublisher {
  /** Record the catalog an agent's next step would publish. */
  prepare: (agent: Agent, catalog: CatalogPublication) => void
  /** Forget the catalog: this agent has none to publish. */
  forget: (agent: Agent) => void
  /** The message that publishes the agent's catalog, or undefined when it did not change. */
  publish: (agent: Agent) => UserMessage | undefined
}

export interface ActivateToolsParams {
  identifiers: string[]
  reason: string
}

/** Why an entry left the session's activated set. */
export type ReleaseReasonKind = typeof RELEASE_REASON_KINDS[number]

export interface ReleaseReason {
  /** `active` is the model's own decision; `idle` and `cap` are the passive policy. */
  kind: ReleaseReasonKind
  /** The words the model (or the policy) gave for the release. */
  text?: string
}

/** One entry this session released, as the catalog message carries it. */
export interface ReleasedEntry {
  /** The identifier the entry was activated and released by. */
  identifier: string
  /** The tool names the release took out of the session's enabled set. */
  names: string[]
  reason: ReleaseReason
}

/**
 * What one release call did: the entries it took out of the session, the ones it
 * refused, and the ones that were not activated to begin with.
 */
export interface ReleaseReceipt {
  /** True when a release took effect, or when every name it named was already released. */
  success: boolean
  released: {
    /** The identifiers the session released. */
    identifiers: string[]
    /** The tool names the release took out of the enabled set. */
    toolNames: string[]
  }
  /** The names the session may not release, each with the reason why. */
  refused: Array<{ identifier: string, reason: string }>
  /** The identifiers this scope does not know at all. */
  notFound: string[]
  /** The identifiers that were not activated, so the release changed nothing. */
  alreadyReleased: string[]
}

export interface DeactivateToolsParams {
  identifiers: string[]
  reason: string
}

export interface ActivateSkillParams {
  name: string
}

export interface ActivatedToolInfo {
  apiCount: number
  avatar?: string
  identifier: string
  name: string
  /**
   * Names of the tools this entry carries. The identifiers of a group disappear
   * with the group, so the names are what keeps an activated tool alive across a
   * rename or a split.
   */
  tools?: string[]
}

export interface ActivateToolsState {
  activatedSkills: unknown[]
  activatedTools: ActivatedToolInfo[]
  alreadyActive: string[]
  notFound: string[]
}

export interface ActivationResult {
  content: string
  state?: ActivateToolsState | unknown
  success: boolean
}

export interface ToolManifestInfo {
  apiDescriptions: Array<{ description: string, name: string }>
  avatar?: string
  identifier: string
  name: string
  systemRole?: string
}

export interface ActivatorRuntimeService {
  activateSkill?: (args: ActivateSkillParams) => Promise<ActivationResult>
  explainNotFound?: (identifier: string) => string | undefined
  /**
   * Which of the requested identifiers are already active. An identifier counts as
   * active when its catalog entry exists and every tool it carries is already
   * enabled: the identifier string alone does not decide it, because a group can
   * be renamed or split after the session activated it.
   */
  getActiveIdentifiers: (identifiers: readonly string[]) => readonly string[]
  getToolManifests: (identifiers: string[]) => Promise<ToolCatalogItem[]>
  markActivated: (identifiers: string[]) => void
}

export interface AvailableToolItem {
  description: string
  identifier: string
  name: string
}

export interface ToolCatalogItem extends ToolManifestInfo {
  description: string
  tools: ToolSchema[]
  sections: string[]
}

export interface ActivatedSkillInfo {
  id: string
  name: string
  description: string
  source: string
  title: string
  hasResources: boolean
  provider?: string
  instructions?: string
}

export interface ActivationEnvelope {
  producer: 'dsh-tool-activator'
  version: 1
  content: string
  success: boolean
  state: {
    activatedTools: ActivatedToolInfo[]
    activatedSkills: ActivatedSkillInfo[]
    alreadyActive: string[]
    notFound: string[]
  }
}

export interface ActivationReceipt extends ActivationEnvelope {
  authorized: true
  approvalRequired: boolean
  commit: ActivationCommit
}

/**
 * The idle clock of one session.
 *
 * The clock is a function of the session log alone: it says which turn each
 * tool was last used on. That is what makes the passive policy replayable —
 * a restored session continues with the clock its log describes, and the same
 * log always produces the same clock.
 */
export interface IdleClock {
  /** The highest turn the log reached: the turn the session is in now. */
  currentTurn: number
  /** The turn each tool name was last called on. */
  calls: Map<string, number>
  /** The turn each identifier was last activated on by a committed activation. */
  activations: Map<string, number>
  /** The turn each tool name was last activated on. */
  activatedNames: Map<string, number>
  /** The highest turn a step of the log has closed on: 0 before any step ended. */
  closedStepTurn: number
}

/**
 * What this session released and has not activated again.
 *
 * The projected account folds on its own schedule, so a release has to be
 * remembered on its own: without this baseline the next assembly would hand the
 * tools back before the fold caught up.
 */
export interface ReleasedBaseline {
  /** The identifiers that were released. */
  identifiers: Set<string>
  /** The tool names that were released. */
  names: Set<string>
}

/**
 * The account of one session: what it may call, what it holds and how long it
 * has held it.
 *
 * Every passive policy and the release decision are read from this one set of
 * facts, so they cannot drift apart.
 */
export interface SessionAccount {
  /** The catalog of this session's scope. */
  catalog: readonly ToolCatalogItem[]
  /** The configuration of the moment. */
  policy: ToolPolicy
  /** What the session activated. */
  history: ActivationHistory
  /** Which turn each tool was last used on. */
  clock: IdleClock
  /** What this session already released. */
  released?: ReleasedBaseline
}
export interface ActivationHistory {
  activatedToolIds: string[]
  /**
   * Names of the tools this session activated. A group identifier vanishes with
   * the group, so these names are what keeps the tools callable afterwards.
   * Absent in sessions activated before the names were recorded.
   */
  activatedToolNames?: string[]
  activatedSkills: ActivatedSkillInfo[]
  /**
   * Decision 13: a skill activation hands the model instructions rather than a
   * schema, so v1 does not release one. The field is reserved for that separate
   * column: nothing writes it and nothing reads it yet.
   */
  skillReleases?: ReleasedEntry[]
  pendingCalls: string[]
  pendingActivations?: Array<{ callId: string, parentCallId: string, activation: ActivationReceipt }>
  pendingRequests?: Array<{ callId: string, identifiers: string[] }>
  approvalRequests?: Array<{ id: string, callId: string }>
  approvedCalls?: string[]
  /**
   * Calls of the grouping tool whose result has not been folded yet. The fold
   * needs them to tell a grouping result from any other tool result, which
   * carries no tool name.
   */
  pendingGroupingCalls?: string[]
  /**
   * Calls of the release tool whose result has not been folded yet. The fold
   * needs them to tell a release result from any other tool result, which
   * carries no tool name of its own.
   */
  pendingDeactivateCalls?: string[]
}

export interface ActivationCommit {
  producer: 'dsh-tool-activator'
  version: 1
  callId: string
  activatedToolIds: string[]
  activatedSkills: ActivatedSkillInfo[]
}

export interface ActivationCatalogEntry {
  identifier: string
  name: string
  description: string
  tools: string[]
}

export interface ActivationCatalog {
  autoGroupMcp: boolean
  basicTools: string[]
  baseTools: string[]
  entries: ActivationCatalogEntry[]
  groups: ToolGroup[]
  requireApproval: boolean
  /**
   * 工具名集合：分组或基础工具里仍配置着、但当前真实工具面已不存在的名字，
   * 宿主端判定，配置页据此标注缺失成员。可选：旧宿主的返回没有这个字段。
   */
  uninstalledToolNames?: string[]
}

/**
 * What the prompt-assembly waterfall actually receives. Hosts before dsh 0.2.2
 * handed over the tool declarations in the same object; from 0.2.2 the waterfall
 * receives a bare presentation and the provider-owned schemas are merged
 * afterwards, so `tools` must be treated as optional rather than assumed.
 */
export type AssembledPrompt = Omit<PromptAssembly, 'tools'> & { tools?: readonly ToolSchema[] }

/**
 * Discriminant of a group invariant violation. Later checks (unknown group name,
 * unknown tool, locked tool) join this union so consumers branch on `kind`
 * instead of matching the reason text.
 */
export type GroupProblemKind
  = | 'duplicate-identifier'
    | 'empty-group'
    | 'tool-in-multiple-groups'
    | 'invalid-identifier'
    | 'existing-group'
    | 'unknown-group'
    | 'unknown-tool'
    | 'locked-tool'
    | 'basic-tool'
    | 'empty-tools'
    | 'description-too-long'
    | 'reserved-identifier'
    | 'claimed-tool'
    | 'immutable-basic'

export interface GroupProblem {
  /** Which invariant was broken. */
  kind: GroupProblemKind
  /** Index of the offending group in the checked group list. */
  groupIndex?: number
  /** Index of the offending operation in the batch; absent for configuration problems. */
  opIndex?: number
  /** Identifier of the offending group. */
  groupIdentifier: string
  /** Index of the other group the conflict was found with, when there is one. */
  conflictingGroupIndex?: number
  /** Tool the problem is about, when it is about one specific tool. */
  tool?: string
  /** Why the batch is rejected; wording of the established validation errors. */
  reason: string
}

/**
 * What the model may ask the grouping tool to do. `apply` writes the grouping back
 * into the plugin configuration; the action is part of the contract from the start,
 * so the write path lands on a stable shape.
 */
export type GroupingAction = 'list' | 'apply'

/** One incremental group edit, addressed by the group identifier it names. */
export type GroupOpKind = 'add' | 'update' | 'remove'

export interface GroupOp {
  op: GroupOpKind
  identifier: string
  name?: string
  description?: string
  tools?: string[]
  /**
   * The identifier the group carries after the operation. Only an update may
   * rename a group, and the new identifier has to be free.
   */
  rename?: string
}

export interface GroupingToolParams {
  action: GroupingAction
  ops?: GroupOp[]
}

export interface GroupMemberView {
  name: string
  /** 该成员在已安装工具里找不到时为 true（插件被卸载后残留的成员） */
  missing?: true
}

export interface GroupView {
  identifier: string
  name: string
  description: string
  tools: GroupMemberView[]
}

export interface GroupingSnapshot {
  /** 保持配置里的顺序 */
  groups: GroupView[]
  /** 未被任何组认领、且不属于基础工具/锁定工具，按名字升序 */
  unclaimed: string[]
  /** 基础工具，按名字升序 */
  basic: string[]
  /** 锁定工具，按名字升序 */
  locked: string[]
}

/**
 * What one applied batch changed. The receipt names the changes, never the whole
 * state: the caller already knows the state it started from.
 */
export interface GroupApplyReceipt {
  created: string[]
  /** The identifiers the rewritten groups carry after the batch. */
  updated: string[]
  removed: string[]
  renamed: Array<{ from: string, to: string }>
  /**
   * The groups an update asked for exactly as they already were. They are a
   * success, but they are not rewrites.
   */
  unchanged: string[]
}

/**
 * What the grouping tool answers with: the action it served plus what that
 * action produced. A rejected batch answers with its problems and writes
 * nothing; an applied batch answers with the receipt of its changes.
 */
export type GroupingToolResult
  = | ({ action: 'list' } & GroupingSnapshot)
    | {
      action: 'apply'
      problems?: GroupProblem[]
      receipt?: GroupApplyReceipt
      /**
       * Tool names a rename or a removal would otherwise drop from the
       * activation account. The session log carries them, so the tools a
       * session already had stay callable after the group they came from is
       * renamed or deleted.
       */
      migrated?: string[]
    }
