import type { PassiveReleaseDraft } from './types'
import { describe, expect, it } from 'vitest'
import { countProblem, passiveReleaseSavable, passiveReleaseValue, readPassiveReleaseDraft } from './passive-release'

function draft(overrides: Partial<PassiveReleaseDraft> = {}): PassiveReleaseDraft {
  return { enabled: true, idleTurns: '6', maxActivatedTools: '24', ...overrides }
}

describe('passive release draft', () => {
  it('starts from the schema defaults when the document carries no block', () => {
    expect(readPassiveReleaseDraft(undefined)).toEqual({ enabled: true, idleTurns: '6', maxActivatedTools: '24' })
    expect(readPassiveReleaseDraft({})).toEqual({ enabled: true, idleTurns: '6', maxActivatedTools: '24' })
  })

  it('reads a stored block into the draft', () => {
    expect(readPassiveReleaseDraft({ enabled: false, idleTurns: 3, maxActivatedTools: 12 })).toEqual({ enabled: false, idleTurns: '3', maxActivatedTools: '12' })
  })

  it('fills a partial block from the defaults', () => {
    expect(readPassiveReleaseDraft({ enabled: false })).toEqual({ enabled: false, idleTurns: '6', maxActivatedTools: '24' })
  })

  it('keeps a count the Host would refuse in the draft', () => {
    expect(readPassiveReleaseDraft({ idleTurns: 0 }).idleTurns).toBe('0')
    expect(readPassiveReleaseDraft({ maxActivatedTools: 2.5 }).maxActivatedTools).toBe('2.5')
  })

  it('accepts whole numbers of at least one', () => {
    expect(passiveReleaseSavable(draft({ idleTurns: '1' }))).toBe(true)
    expect(passiveReleaseSavable(draft({ maxActivatedTools: '9999' }))).toBe(true)
  })

  it.each(['', '0', '-1', '1.5', 'abc', '6 turns'])('refuses a count that is not a whole number of at least one: %j', (text) => {
    expect(passiveReleaseSavable(draft({ idleTurns: text }))).toBe(false)
    expect(passiveReleaseSavable(draft({ maxActivatedTools: text }))).toBe(false)
  })

  it('builds the block the Host document stores', () => {
    expect(passiveReleaseValue(draft({ enabled: false, idleTurns: '3', maxActivatedTools: '12' }))).toEqual({ enabled: false, idleTurns: 3, maxActivatedTools: 12 })
  })

  it('stores no block for a draft the Host would refuse', () => {
    expect(passiveReleaseValue(draft({ idleTurns: '0' }))).toBeUndefined()
    expect(passiveReleaseValue(draft({ maxActivatedTools: 'abc' }))).toBeUndefined()
  })

  it('names the count the Host would refuse', () => {
    const idle = '空闲轮数必须是大于等于 1 的整数。'
    const cap = '激活工具上限必须是大于等于 1 的整数。'
    expect(countProblem('0', idle)).toBe(idle)
    expect(countProblem('6', idle)).toBe('')
    expect(countProblem('abc', cap)).toBe(cap)
    expect(countProblem('24', cap)).toBe('')
  })
})
