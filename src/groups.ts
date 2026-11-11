import type { ToolGroup } from './shared'
import type { GroupApplyReceipt, GroupingSnapshot, GroupMemberView, GroupOp, GroupProblem, GroupView } from './types'
import { collectGroupProblems } from './config'
import { BASIC_GROUP_IDENTIFIER, GROUP_DESCRIPTION_LIMIT, GROUP_IDENTIFIER_PATTERN, LOCKED_TOOL_NAMES } from './constants'

/**
 * The facts a grouping snapshot is read from: the configured groups, the tools
 * this scope actually offers, and the two sets no group is allowed to touch.
 */
export interface GroupingFacts {
  groups: readonly ToolGroup[]
  /** 当前作用域里真实存在的工具名 */
  tools: readonly string[]
  basicTools: readonly string[]
  lockedTools: readonly string[]
}

/** The order every tool-name list is presented in. */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Project the configured groups onto the tools of the current scope.
 *
 * A member that no longer exists stays in its group and is flagged `missing`:
 * dropping it silently would hide the fact that the plugin behind it was
 * uninstalled, and the user has to decide whether to drop or replace it.
 *
 * The unclaimed list is what the model may freely regroup: a tool that a group
 * already claims is not up for grabs, and the basic and locked tools are never
 * group material. A tool that is both a group member and a basic tool stays a
 * member — the configuration allows it, the settings page is the place that
 * refuses it.
 */
export function groupingSnapshot(facts: GroupingFacts): GroupingSnapshot {
  const installed = new Set(facts.tools)
  const claimed = new Set<string>()
  const groups = facts.groups.map((group) => {
    const tools = group.tools.map((name): GroupMemberView => {
      claimed.add(name)
      return installed.has(name) ? { name } : { name, missing: true }
    })
    return { identifier: group.identifier, name: group.name, description: group.description, tools }
  })
  const reserved = new Set([...facts.basicTools, ...facts.lockedTools])
  const unclaimed = [...installed].filter(name => !claimed.has(name) && !reserved.has(name)).sort(byName)
  // The always-loaded tools are addressed as a group so that their membership is
  // edited through the same operations. A configured group that somehow owns the
  // reserved identifier wins, and no synthetic entry is added next to it.
  const basicGroup: GroupView = {
    identifier: BASIC_GROUP_IDENTIFIER,
    name: 'Basic tools',
    description: 'Always loaded. The model may add or remove members; the group itself cannot be created or deleted.',
    tools: [...new Set(facts.basicTools)].sort(byName).map((name): GroupMemberView => installed.has(name) ? { name } : { name, missing: true }),
  }
  return {
    groups: facts.groups.some(group => group.identifier === BASIC_GROUP_IDENTIFIER) ? groups : [basicGroup, ...groups],
    unclaimed,
    // The basic and locked sets are configuration facts, not scope facts: they
    // say which tools are off limits, not which of them happen to be installed.
    basic: [...new Set(facts.basicTools)].sort(byName),
    locked: [...new Set(facts.lockedTools)].sort(byName),
  }
}

/**
 * The result of applying a batch of grouping operations: the state the batch
 * would produce, every problem it has, and the receipt of what it changed.
 */
export interface GroupApplyOutcome {
  /** 目标分组状态；problems 非空时它就是现状，调用方不得写入 */
  next: ToolGroup[]
  /** The always-loaded set the batch would leave behind; same contract as `next`. */
  nextBasicTools: string[]
  problems: GroupProblem[]
  receipt: GroupApplyReceipt
}

/** A copy of one group, so a batch never mutates the configuration it read. */
function copyGroup(group: ToolGroup): ToolGroup {
  return {
    identifier: group.identifier,
    name: group.name,
    description: group.description,
    tools: [...group.tools],
    sections: [...group.sections],
  }
}

/**
 * Why one `add` operation cannot be applied. The checks are the ones the
 * configuration itself would make, so a rejected operation never reaches the
 * document, and every fault of the operation is reported at once.
 */
function addProblems(groups: readonly ToolGroup[], op: GroupOp, tools: readonly string[], opIndex: number): GroupProblem[] {
  const problems: GroupProblem[] = []
  if (!GROUP_IDENTIFIER_PATTERN.test(op.identifier)) {
    problems.push({
      kind: 'invalid-identifier',
      opIndex,
      groupIdentifier: op.identifier,
      reason: `Tool group identifier "${op.identifier}" is invalid: it must match ${GROUP_IDENTIFIER_PATTERN.source}`,
    })
  }
  const existingIndex = groups.findIndex(group => group.identifier === op.identifier)
  if (existingIndex >= 0) {
    problems.push({
      kind: 'existing-group',
      opIndex,
      groupIndex: existingIndex,
      groupIdentifier: op.identifier,
      reason: `Tool group ${op.identifier} already exists; change it with "update" instead of adding it again`,
    })
  }
  if (tools.length === 0) {
    problems.push({
      kind: 'empty-tools',
      opIndex,
      groupIdentifier: op.identifier,
      reason: `Tool group ${op.identifier} must carry at least one tool`,
    })
  }
  if ((op.description ?? '').length > GROUP_DESCRIPTION_LIMIT) {
    problems.push({
      kind: 'description-too-long',
      opIndex,
      groupIdentifier: op.identifier,
      reason: `Tool group ${op.identifier} has a description of more than ${GROUP_DESCRIPTION_LIMIT} characters`,
    })
  }
  return problems
}

/**
 * The fields of one group an operation may rewrite. The comparison that decides
 * whether an update changed anything is made on these alone: the sections are
 * the configuration's own business, and no operation touches them.
 */
interface GroupFields {
  identifier: string
  name: string
  description: string
  tools: readonly string[]
}

/** The fields of a group as they are now. */
function fieldsOf(group: ToolGroup): GroupFields {
  return { identifier: group.identifier, name: group.name, description: group.description, tools: group.tools }
}

/**
 * Whether two field sets are the same. The members are compared in order: the
 * configuration keeps the order a group lists its tools in, so another order is
 * another group.
 */
function sameFields(a: GroupFields, b: GroupFields): boolean {
  return a.identifier === b.identifier && a.name === b.name && a.description === b.description
    && a.tools.length === b.tools.length && a.tools.every((tool, index) => tool === b.tools[index])
}

/**
 * Why one `update` operation cannot be applied. The checks are the ones the
 * configuration itself would make, plus the two it cannot see: a rename has to
 * be a legal identifier, and it has to be free.
 */
function updateProblems(groups: readonly ToolGroup[], op: GroupOp, group: ToolGroup, opIndex: number): GroupProblem[] {
  const problems: GroupProblem[] = []
  if (op.rename !== undefined) {
    if (!GROUP_IDENTIFIER_PATTERN.test(op.rename)) {
      problems.push({
        kind: 'invalid-identifier',
        opIndex,
        groupIdentifier: op.rename,
        reason: `Tool group identifier "${op.rename}" is invalid: it must match ${GROUP_IDENTIFIER_PATTERN.source}`,
      })
    }
    else {
      const clash = op.rename === BASIC_GROUP_IDENTIFIER
        ? -1
        : groups.findIndex(other => other !== group && other.identifier === op.rename)
      if (op.rename === BASIC_GROUP_IDENTIFIER) {
        problems.push({
          kind: 'reserved-identifier',
          opIndex,
          groupIdentifier: op.rename,
          reason: `Tool group identifier ${BASIC_GROUP_IDENTIFIER} is reserved for the always-loaded tools`,
        })
      }
      if (clash >= 0) {
        problems.push({
          kind: 'existing-group',
          opIndex,
          groupIndex: clash,
          groupIdentifier: op.rename,
          reason: `Tool group ${op.rename} already exists; rename this group to an identifier that is free`,
        })
      }
    }
  }
  if (op.tools !== undefined && op.tools.length === 0) {
    problems.push({
      kind: 'empty-tools',
      opIndex,
      groupIdentifier: group.identifier,
      reason: `Tool group ${group.identifier} must carry at least one tool`,
    })
  }
  if (op.description !== undefined && op.description.length > GROUP_DESCRIPTION_LIMIT) {
    problems.push({
      kind: 'description-too-long',
      opIndex,
      groupIdentifier: group.identifier,
      reason: `Tool group ${group.identifier} has a description of more than ${GROUP_DESCRIPTION_LIMIT} characters`,
    })
  }
  return problems
}

/** The problem of an operation that names a group the configuration does not have. */
function unknownGroupProblem(identifier: string, opIndex: number): GroupProblem {
  return {
    kind: 'unknown-group',
    opIndex,
    groupIdentifier: identifier,
    reason: `Tool group ${identifier} does not exist`,
  }
}

/**
 * The catalog layer of the check: a member has to exist in this scope, and it
 * may be neither a locked nor a basic tool. The locked list wins over the basic
 * one and over the existence check, because a locked tool is refused whatever
 * the scope happens to offer.
 */
function catalogProblems(groups: readonly ToolGroup[], facts: GroupingFacts, basicTools: readonly string[], written: ReadonlyMap<ToolGroup, readonly string[]>): GroupProblem[] {
  const problems: GroupProblem[] = []
  const installed = new Set(facts.tools)
  const basic = new Set(basicTools)
  for (const [groupIndex, group] of groups.entries()) {
    // Only the members this batch wrote are judged: a member the group already
    // carried is a pre-existing configuration, not a fault of this batch.
    const members = written.get(group)
    if (members === undefined)
      continue
    for (const tool of members) {
      if (LOCKED_TOOL_NAMES.includes(tool)) {
        problems.push({
          kind: 'locked-tool',
          groupIndex,
          groupIdentifier: group.identifier,
          tool,
          reason: `Tool ${tool} is locked and may not belong to a group`,
        })
      }
      else if (basic.has(tool)) {
        problems.push({
          kind: 'basic-tool',
          groupIndex,
          groupIdentifier: group.identifier,
          tool,
          reason: `Tool ${tool} is a basic tool and may not belong to a group`,
        })
      }
      else if (!installed.has(tool)) {
        problems.push({
          kind: 'unknown-tool',
          groupIndex,
          groupIdentifier: group.identifier,
          tool,
          reason: `Tool ${tool} is not installed in this scope`,
        })
      }
    }
  }
  return problems
}

/**
 * Apply a batch of grouping operations to a working copy of the groups.
 *
 * The batch is all-or-nothing: every problem is collected and returned at once,
 * and a batch with a problem leaves the groups exactly as they were — the
 * receipt of a rejected batch reports no change at all.
 *
 * The operations are applied to the working copy in the order they were given,
 * so one call may move a tool from one group to another by removing the old
 * group and adding the new one. Only the state the batch produces is judged:
 * the state in between is not a fault of the batch.
 */
export function applyGroupOps(facts: GroupingFacts, ops: readonly GroupOp[]): GroupApplyOutcome {
  const working = facts.groups.map(copyGroup)
  const workingBasic = [...new Set(facts.basicTools)]
  // The members this batch wrote into the basic set, and the operation that did
  // it. Only these are judged: a basic tool the configuration already carried is
  // the user's own setup, not a fault of this batch.
  const writtenBasic = new Set<string>()
  let basicOpIndex: number | undefined
  const problems: GroupProblem[] = []
  const created: string[] = []
  const updated: string[] = []
  const removed: string[] = []
  const renamed: Array<{ from: string, to: string }> = []
  const unchanged: string[] = []
  // The members this batch wrote for each group it wrote. The catalog layer
  // judges exactly these: a member the batch did not write is the user's own
  // configuration, and refusing a rename over it would leave the group
  // unusable until the user cleaned that group by hand.
  const written = new Map<ToolGroup, readonly string[]>()
  // The operation that put each group in place, so that a problem about a group
  // can name the operation that caused it.
  const origin = new Map<ToolGroup, number>()

  ops.forEach((op, opIndex) => {
    if (op.identifier === BASIC_GROUP_IDENTIFIER) {
      if (op.op !== 'update') {
        problems.push({
          kind: 'reserved-identifier',
          opIndex,
          groupIdentifier: op.identifier,
          reason: `Tool group ${BASIC_GROUP_IDENTIFIER} is the always-loaded set: it cannot be created or deleted, only its membership can be updated`,
        })
        return
      }
      if (op.rename !== undefined || op.name !== undefined || op.description !== undefined) {
        problems.push({
          kind: 'immutable-basic',
          opIndex,
          groupIdentifier: op.identifier,
          reason: `Tool group ${BASIC_GROUP_IDENTIFIER} has no name, description or identifier to change; only its members can be updated`,
        })
      }
      if (op.tools === undefined) {
        unchanged.push(BASIC_GROUP_IDENTIFIER)
        return
      }
      const before = [...workingBasic]
      const after = [...new Set(op.tools)]
      workingBasic.splice(0, workingBasic.length, ...after)
      basicOpIndex = opIndex
      for (const tool of after) writtenBasic.add(tool)
      if (before.length === after.length && before.every((tool, at) => tool === after[at]))
        unchanged.push(BASIC_GROUP_IDENTIFIER)
      else
        updated.push(BASIC_GROUP_IDENTIFIER)
      return
    }
    if (op.op === 'add') {
      const tools = op.tools ?? []
      const rejections = addProblems(working, op, tools, opIndex)
      if (rejections.length > 0) {
        problems.push(...rejections)
        return
      }
      const group: ToolGroup = {
        identifier: op.identifier,
        name: op.name ?? '',
        description: op.description ?? '',
        tools: [...tools],
        sections: [],
      }
      working.push(group)
      written.set(group, [...tools])
      origin.set(group, opIndex)
      created.push(op.identifier)
      return
    }
    if (op.op === 'update') {
      const index = working.findIndex(entry => entry.identifier === op.identifier)
      if (index < 0) {
        problems.push(unknownGroupProblem(op.identifier, opIndex))
        return
      }
      const group = working[index]
      const rejections = updateProblems(working, op, group, opIndex)
      if (rejections.length > 0) {
        problems.push(...rejections)
        return
      }
      const before = fieldsOf(group)
      const after: GroupFields = {
        identifier: op.rename ?? before.identifier,
        name: op.name ?? before.name,
        description: op.description ?? before.description,
        // The members are the whole membership: an update replaces them, it
        // does not patch them.
        tools: op.tools === undefined ? before.tools : [...op.tools],
      }
      group.identifier = after.identifier
      group.name = after.name
      group.description = after.description
      group.tools = [...after.tools]
      origin.set(group, opIndex)
      if (sameFields(before, after)) {
        // The operation asked for what the group already is: that is a success,
        // but the receipt must not claim a rewrite that did not happen.
        unchanged.push(before.identifier)
      }
      else {
        updated.push(after.identifier)
        if (after.identifier !== before.identifier)
          renamed.push({ from: before.identifier, to: after.identifier })
      }
      if (op.tools !== undefined)
        written.set(group, [...op.tools])
      return
    }
    const index = working.findIndex(entry => entry.identifier === op.identifier)
    if (index < 0) {
      problems.push(unknownGroupProblem(op.identifier, opIndex))
      return
    }
    const [group] = working.splice(index, 1)
    removed.push(group.identifier)
  })

  // The invariant layer runs on the final state: two operations of one batch may
  // collide with each other, and only the state they produce together tells
  // whether the batch is coherent. The catalog layer judges the members this
  // batch wrote — refusing an unrelated change over a group that predates it
  // would leave the whole tool unusable until the user cleaned that group by hand.
  const withOrigin = (problem: GroupProblem): GroupProblem => {
    if (problem.opIndex !== undefined || problem.groupIndex === undefined)
      return problem
    const opIndex = origin.get(working[problem.groupIndex])
    return opIndex === undefined ? problem : { ...problem, opIndex }
  }
  problems.push(...collectGroupProblems(working).map(withOrigin))
  problems.push(...catalogProblems(working, facts, workingBasic, written).map(withOrigin))
  // The members this batch wrote into the basic set are judged against the state
  // the batch produces: a group it removes may free a tool in the same call.
  const claimedBy = new Map<string, string>()
  for (const group of working) {
    for (const tool of group.tools) {
      if (!claimedBy.has(tool))
        claimedBy.set(tool, group.identifier)
    }
  }
  for (const tool of writtenBasic) {
    if (LOCKED_TOOL_NAMES.includes(tool)) {
      problems.push({ kind: 'locked-tool', opIndex: basicOpIndex, groupIdentifier: BASIC_GROUP_IDENTIFIER, tool, reason: `Tool ${tool} is locked and may not belong to a group` })
      continue
    }
    const owner = claimedBy.get(tool)
    if (owner !== undefined) {
      problems.push({ kind: 'claimed-tool', opIndex: basicOpIndex, groupIdentifier: BASIC_GROUP_IDENTIFIER, tool, reason: `Tool ${tool} belongs to the group ${owner}, so it cannot become a basic tool` })
      continue
    }
    if (!facts.tools.includes(tool))
      problems.push({ kind: 'unknown-tool', opIndex: basicOpIndex, groupIdentifier: BASIC_GROUP_IDENTIFIER, tool, reason: `Tool ${tool} is not installed in this scope` })
  }
  // The problems follow the order of the operations that caused them, so the
  // model can walk them one by one; the problems of the configuration itself come
  // last, because no operation of this batch caused them.
  problems.sort((a, b) => (a.opIndex ?? Number.MAX_SAFE_INTEGER) - (b.opIndex ?? Number.MAX_SAFE_INTEGER))

  if (problems.length > 0) {
    // A rejected batch changes nothing: the groups stay as they were and the
    // receipt reports no change, so a caller that writes the result of a
    // rejected batch writes the configuration back unchanged.
    return {
      next: facts.groups.map(copyGroup),
      nextBasicTools: [...new Set(facts.basicTools)],
      problems,
      receipt: { created: [], updated: [], removed: [], renamed: [], unchanged: [] },
    }
  }
  return {
    next: working,
    nextBasicTools: workingBasic,
    problems,
    receipt: { created, updated, removed, renamed, unchanged },
  }
}
