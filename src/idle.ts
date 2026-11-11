import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { IdleClock, SessionAccount } from './types'
import { receiptFromContent } from './activation'
import { activeAccount } from './release'

/**
 * The clock of a session.
 *
 * The clock is read against the session's account — the entries the session
 * activated and the turns it used them on — and that account is what every
 * passive policy decides from.
 */

export function emptyIdleClock(): IdleClock {
  return { currentTurn: 0, closedStepTurn: 0, calls: new Map(), activations: new Map(), activatedNames: new Map() }
}

/**
 * Fold one session event into the clock.
 *
 * A tool call is a use of that tool. An activation is a use of everything it
 * brings in: the session asked for those tools, so the entry starts its idle
 * clock there. The activation receipt names the members exactly, which is what
 * keeps a name whose group was renamed afterwards on a clock of its own.
 *
 * Only a committed activation touches the clock. A request that was refused
 * or that failed never gave the session the tools, so it is not a use of them:
 * the entry keeps the clock its last successful activation gave it.
 */
export function foldIdleEvent(clock: IdleClock, event: SessionEvent): IdleClock {
  if (event.type === 'tool/call') {
    const turn = event.data.turn
    if (turn > clock.currentTurn)
      clock.currentTurn = turn
    clock.calls.set(event.data.name, turn)
    return clock
  }
  if (event.type === 'tool/result') {
    const turn = event.data.turn
    if (turn > clock.currentTurn)
      clock.currentTurn = turn
    const receipt = receiptFromContent(event.data.message.content)
    if (receipt) {
      for (const tool of receipt.state.activatedTools) {
        clock.activations.set(tool.identifier, turn)
        for (const name of tool.tools ?? [])
          clock.activatedNames.set(name, turn)
      }
      // An entry the session already holds is still a use of it: the model asked
      // for it again, so its idle clock starts over.
      for (const identifier of receipt.state.alreadyActive)
        clock.activations.set(identifier, turn)
    }
    return clock
  }
  if (event.type === 'step/end') {
    // The turn a step closed on is the log's record that the turn already
    // assembled: the cap reads it to hold its excess until the next turn.
    if (event.data.turn > clock.closedStepTurn)
      clock.closedStepTurn = event.data.turn
    if (event.data.turn > clock.currentTurn)
      clock.currentTurn = event.data.turn
    return clock
  }
  if ('turn' in event.data && event.data.turn > clock.currentTurn)
    clock.currentTurn = event.data.turn
  return clock
}

/** The clock a session log describes. */
export function idleClockOf(events: readonly SessionEvent[]): IdleClock {
  const clock = emptyIdleClock()
  for (const event of events)
    foldIdleEvent(clock, event)
  return clock
}

/**
 * One unit the session activated, with the clock's view of it.
 *
 * The unit is the entry: a group is one unit whatever it carries, and a tool
 * name no activated entry provides is a unit of its own, because nothing else
 * would ever account for it.
 */
export interface SessionEntry {
  /** The identifier the session activated it by; an orphan tool name is its own identifier. */
  identifier: string
  /** The tool names the unit holds in the session's enabled set. */
  names: string[]
  /** The turn the unit was last used on: the turn any of its members ran. */
  lastUse: number
  /** The turn the unit was last activated on. */
  activatedTurn: number
}

/** The facts the session's entries are read from: the account without its policy. */
export type SessionEntryFacts = Omit<SessionAccount, 'policy'>

/**
 * The units this session activated, as the log describes them.
 *
 * The account is what the passive policies are decided on: the entries the
 * session activated and the turns the clock saw them used on. The last use of
 * an entry is the last use of any of its members, and the activation turn is
 * the turn the session last asked for it.
 *
 * The account is a pure function of the session's log, so the same log always
 * answers the same way — whether the account came from the projection or from
 * the in-memory release baseline.
 */
export function sessionEntries(facts: SessionEntryFacts): SessionEntry[] {
  const account = activeAccount(facts.history, facts.released)
  const activatedIds = account.identifiers
  const activatedNames = account.names
  const byIdentifier = new Map(facts.catalog.map(entry => [entry.identifier, entry]))
  const entries: SessionEntry[] = []
  // The names an activated entry provides are accounted for by that entry.
  const covered = new Set<string>()
  for (const identifier of activatedIds) {
    const entry = byIdentifier.get(identifier)
    // An entry the catalog does not know any more has no members to reclaim.
    if (!entry)
      continue
    const names = entry.tools.map(tool => tool.name)
    let lastUse = facts.clock.activations.get(identifier) ?? 0
    let activatedTurn = facts.clock.activations.get(identifier) ?? 0
    for (const name of names) {
      covered.add(name)
      lastUse = Math.max(lastUse, facts.clock.calls.get(name) ?? 0, facts.clock.activatedNames.get(name) ?? 0)
      activatedTurn = Math.max(activatedTurn, facts.clock.activatedNames.get(name) ?? 0)
    }
    entries.push({ identifier, names, lastUse, activatedTurn })
  }
  for (const name of activatedNames) {
    if (covered.has(name))
      continue
    const activatedTurn = facts.clock.activatedNames.get(name) ?? 0
    const lastUse = Math.max(facts.clock.calls.get(name) ?? 0, activatedTurn)
    entries.push({ identifier: name, names: [name], lastUse, activatedTurn })
  }
  return entries
}

/** One unit the session activated, and how long it sat unused. */
export interface IdleCandidate {
  /** The identifier the unit was activated by. */
  identifier: string
  /** How many turns the unit sat unused. */
  idleTurns: number
}

/** The facts one idle decision is read from: the session's whole account. */
export type IdleFacts = SessionAccount

/**
 * Decide which activations this session left idle for too long.
 *
 * The unit of the decision is the activated entry: an entry counts as used
 * when any of its members ran. A tool name no activated entry provides counts
 * on its own, because nothing else would ever account for it.
 *
 * The decision is a pure function of the session's log and account, so the
 * same log always answers the same way — whether the account came from the
 * projection or from the in-memory release baseline.
 */
export function planIdleRelease(facts: IdleFacts): IdleCandidate[] {
  const threshold = facts.policy.passiveRelease.idleTurns + 1
  const current = facts.clock.currentTurn
  const candidates: IdleCandidate[] = []
  for (const entry of sessionEntries(facts)) {
    const idleTurns = current - entry.lastUse
    if (idleTurns >= threshold)
      candidates.push({ identifier: entry.identifier, idleTurns })
  }
  return candidates
}
