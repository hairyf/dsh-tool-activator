import type { SessionEntry } from './idle'
import type { ToolPolicy } from './shared'
import type { SessionAccount } from './types'
import { sessionEntries } from './idle'
import { isReleasableName } from './release'

/**
 * The facts one cap decision is read from: the session's account plus what
 * this round releases for another reason.
 */
export type CapFacts = SessionAccount & {
  /**
   * The identifiers this round releases for another reason. They leave the
   * session's set in the same batch, so the count must not ask for them twice.
   */
  excluded?: readonly string[]
}

/** One entry the cap takes out of the session's enabled set. */
export interface CapCandidate {
  /** The identifier the entry is activated and released by. */
  identifier: string
  /** The tool names the entry holds against the cap. */
  names: string[]
  /** The turn the entry was last used on. */
  lastUse: number
  /** The turn the entry was last activated on. */
  activatedTurn: number
}

/**
 * The tool names that count against the cap.
 *
 * The cap bounds what a session holds on top of its standing tools: the basic
 * tools are always loaded and the tools that manage the catalog itself are
 * always in the model's face, so neither of them counts.
 */
function countedNames(entries: readonly SessionEntry[], policy: ToolPolicy): Set<string> {
  const counted = new Set<string>()
  for (const entry of entries) {
    for (const name of entry.names) {
      if (!isReleasableName(name, policy))
        continue
      counted.add(name)
    }
  }
  return counted
}

/**
 * The order the entries leave in: the least recently used first.
 *
 * The order is total, so the same account always trims the same entries: the
 * least recently used goes first, an entry that was activated earlier goes
 * before one that was activated later, and the name settles what is left.
 */
function byLeastRecentlyUsed(a: SessionEntry, b: SessionEntry): number {
  if (a.lastUse !== b.lastUse)
    return a.lastUse - b.lastUse
  if (a.activatedTurn !== b.activatedTurn)
    return a.activatedTurn - b.activatedTurn
  return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0
}

/**
 * Decide which activations the cap squeezes out of this session.
 *
 * The count is the session's activated tool names: the names it activated on
 * their own plus the current members of the entries it activated, without the
 * basic tools and without the tools that manage the catalog. When there are
 * more of them than the cap allows, the least recently used entries leave
 * until the count fits.
 *
 * The decision only runs on the first assembly of a turn: one big activation
 * may exceed the cap for the rest of that turn, and the next turn's first
 * assembly trims it — a step the turn has closed is the log's proof that the
 * turn already assembled.
 *
 * The decision is a pure function of the session's account, so the same log
 * always squeezes out the same entries.
 */
export function planCapRelease(facts: CapFacts): CapCandidate[] {
  // 时序（决策 5，B 案）：上限裁剪只发生在本 turn 的首次装配。「已关闭的步」
  // 是日志里「本 turn 已经装配过」的凭证——还没有本 turn 的步关闭过就是首次
  // 装配，允许临时超限；同一 turn 之后的装配不再裁剪，等下一个 turn 再修剪。
  if (facts.clock.closedStepTurn >= facts.clock.currentTurn)
    return []
  const max = facts.policy.passiveRelease.maxActivatedTools
  const excluded = new Set(facts.excluded ?? [])
  const entries = sessionEntries(facts).filter(entry => !excluded.has(entry.identifier))
  const counted = countedNames(entries, facts.policy)
  if (counted.size <= max)
    return []
  const candidates: CapCandidate[] = []
  for (const entry of [...entries].sort(byLeastRecentlyUsed)) {
    if (counted.size <= max)
      break
    // The entry the session activated this turn is not reclaimed this turn.
    if (entry.activatedTurn === facts.clock.currentTurn)
      continue
    const names = entry.names.filter(name => counted.has(name))
    if (names.length === 0)
      continue
    for (const name of names)
      counted.delete(name)
    candidates.push({ identifier: entry.identifier, names, lastUse: entry.lastUse, activatedTurn: entry.activatedTurn })
  }
  return candidates
}
