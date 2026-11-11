import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolPolicy } from './shared'
import type { ActivationHistory, IdleClock, ToolCatalogItem } from './types'
import { describe, expect, it } from 'vitest'
import { planCapRelease } from './cap'
import { DEFAULT_PASSIVE_RELEASE } from './shared'

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    basicTools: ['basic_tool'],
    requireApproval: true,
    autoGroupMcp: true,
    passiveRelease: { ...DEFAULT_PASSIVE_RELEASE },
    groups: [],
    sectionTools: {},
    ...overrides,
  }
}

function capPolicy(maxActivatedTools: number): ToolPolicy {
  return policy({ passiveRelease: { ...DEFAULT_PASSIVE_RELEASE, maxActivatedTools } })
}

function tool(name: string): ToolSchema {
  return { name, description: `${name} description`, parameters: { type: 'object', properties: {} } }
}

function entry(identifier: string, names: readonly string[]): ToolCatalogItem {
  const tools = names.map(tool)
  return {
    identifier,
    name: identifier,
    description: '',
    apiDescriptions: tools.map(item => ({ name: item.name, description: item.description })),
    tools,
    sections: [],
  }
}

function history(overrides: Partial<ActivationHistory> = {}): ActivationHistory {
  return { activatedToolIds: [], activatedToolNames: [], activatedSkills: [], pendingCalls: [], ...overrides }
}

function clock(overrides: Partial<IdleClock> = {}): IdleClock {
  return { currentTurn: 0, closedStepTurn: 0, calls: new Map(), activations: new Map(), activatedNames: new Map(), ...overrides }
}

const catalog = [entry('alpha', ['alpha_tool']), entry('beta', ['beta_tool']), entry('gamma', ['gamma_tool'])]

/** Three entries the session activated, each on the turn its activation ran. */
function threeEntries(turns: readonly [number, number, number]): { history: ActivationHistory, clock: IdleClock } {
  const [alpha, beta, gamma] = turns
  return {
    history: history({
      activatedToolIds: ['alpha', 'beta', 'gamma'],
      activatedToolNames: ['alpha_tool', 'beta_tool', 'gamma_tool'],
    }),
    clock: clock({
      currentTurn: 5,
      activations: new Map([['alpha', alpha], ['beta', beta], ['gamma', gamma]]),
      activatedNames: new Map([['alpha_tool', alpha], ['beta_tool', beta], ['gamma_tool', gamma]]),
    }),
  }
}

describe('planCapRelease', () => {
  it('leaves the basic and the locked tools out of the count', () => {
    const facts = {
      catalog,
      policy: capPolicy(3),
      history: history({
        activatedToolIds: ['alpha', 'beta', 'gamma'],
        activatedToolNames: ['alpha_tool', 'beta_tool', 'gamma_tool', 'basic_tool', 'activate_tools'],
      }),
      clock: clock({
        currentTurn: 5,
        activations: new Map([['alpha', 1], ['beta', 1], ['gamma', 1]]),
        activatedNames: new Map([['alpha_tool', 1], ['beta_tool', 1], ['gamma_tool', 1], ['basic_tool', 1], ['activate_tools', 1]]),
      }),
    }

    // Three counted names and a cap of three: the basic tool and the tool that
    // manages the catalog are never counted against it.
    expect(planCapRelease(facts)).toEqual([])
  })

  it('counts the names the session activated on their own', () => {
    const facts = {
      catalog,
      policy: capPolicy(1),
      history: history({ activatedToolNames: ['alpha_tool', 'beta_tool'] }),
      clock: clock({
        currentTurn: 5,
        activatedNames: new Map([['alpha_tool', 1], ['beta_tool', 3]]),
      }),
    }

    const result = planCapRelease(facts)

    expect(result.map(candidate => candidate.identifier)).toEqual(['alpha_tool'])
  })

  it('squeezes out the least recently used entry first', () => {
    const facts = { catalog, policy: capPolicy(2), ...threeEntries([1, 3, 5]) }

    const result = planCapRelease(facts)

    expect(result.map(candidate => candidate.identifier)).toEqual(['alpha'])
    expect(result[0]?.names).toEqual(['alpha_tool'])
  })

  it('squeezes out as many entries as the cap needs', () => {
    const facts = { catalog, policy: capPolicy(1), ...threeEntries([1, 3, 5]) }

    const result = planCapRelease(facts)

    expect(result.map(candidate => candidate.identifier)).toEqual(['alpha', 'beta'])
  })

  it('sends the entry that was activated earlier out first when the last use ties', () => {
    const facts = {
      catalog,
      policy: capPolicy(2),
      history: history({
        activatedToolIds: ['alpha', 'beta', 'gamma'],
        activatedToolNames: ['alpha_tool', 'beta_tool', 'gamma_tool'],
      }),
      // Every entry was used on turn 5, so the last use ties and the earlier
      // activation decides.
      clock: clock({
        currentTurn: 5,
        activations: new Map([['alpha', 1], ['beta', 3], ['gamma', 5]]),
        activatedNames: new Map([['alpha_tool', 1], ['beta_tool', 3], ['gamma_tool', 5]]),
        calls: new Map([['alpha_tool', 5], ['beta_tool', 5], ['gamma_tool', 5]]),
      }),
    }

    const result = planCapRelease(facts)

    expect(result.map(candidate => candidate.identifier)).toEqual(['alpha'])
  })

  it('sends the entry whose name comes first out first when the last use and the activation tie', () => {
    const facts = { catalog, policy: capPolicy(2), ...threeEntries([1, 1, 1]) }

    const result = planCapRelease(facts)

    expect(result.map(candidate => candidate.identifier)).toEqual(['alpha'])
  })

  it('keeps the entries the session activated this turn', () => {
    const facts = { catalog, policy: capPolicy(1), ...threeEntries([5, 5, 5]) }

    // One big activation may exceed the cap for a round: nothing is squeezed
    // out of the entries the session holds right now.
    expect(planCapRelease(facts)).toEqual([])
  })

  it('squeezes out the entries of the previous round once the turn moved on', () => {
    const facts = { catalog, policy: capPolicy(1), ...threeEntries([4, 4, 4]) }
    const moved = { ...facts, clock: { ...facts.clock, currentTurn: 5 } }

    const result = planCapRelease(moved)

    expect(result.map(candidate => candidate.identifier)).toEqual(['alpha', 'beta'])
  })

  it('waits for the next turn once a step of this turn has closed', () => {
    const facts = { catalog, policy: capPolicy(1), ...threeEntries([1, 3, 5]) }

    // A closed step proves the turn already assembled: the same turn's later
    // assemblies hold the excess instead of trimming it.
    const midTurn = { ...facts, clock: { ...facts.clock, closedStepTurn: 5 } }

    expect(planCapRelease(midTurn)).toEqual([])
  })

  it('trims on the first assembly of the next turn', () => {
    const facts = { catalog, policy: capPolicy(1), ...threeEntries([5, 5, 5]) }

    // The previous turn's temporary excess is trimmed at the next turn's
    // first assembly: the entries are no longer protected by the turn they
    // were activated on.
    const nextTurn = { ...facts, clock: { ...facts.clock, currentTurn: 6 } }

    expect(planCapRelease(nextTurn).map(candidate => candidate.identifier)).toEqual(['alpha', 'beta'])
  })

  it('never reclaims what the session already released', () => {
    const facts = {
      catalog,
      policy: capPolicy(1),
      ...threeEntries([1, 3, 5]),
      released: { identifiers: new Set(['alpha']), names: new Set(['alpha_tool']) },
    }

    const result = planCapRelease(facts)

    expect(result.map(candidate => candidate.identifier)).toEqual(['beta'])
  })

  it('leaves the entries another reason released out of the count', () => {
    const facts = { catalog, policy: capPolicy(1), ...threeEntries([1, 3, 5]) }

    const result = planCapRelease({ ...facts, excluded: ['alpha'] })

    expect(result.map(candidate => candidate.identifier)).toEqual(['beta'])
  })

  it('reads the same account to the same decision twice', () => {
    const facts = { catalog, policy: capPolicy(1), ...threeEntries([1, 3, 5]) }

    expect(planCapRelease(facts)).toEqual(planCapRelease(facts))
  })
})
