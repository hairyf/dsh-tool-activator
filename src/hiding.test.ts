import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCatalogItem } from './types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToolHiding } from './hiding'

afterEach(() => {
  vi.restoreAllMocks()
})

function catalog(names: readonly string[]): ToolCatalogItem[] {
  return [{
    identifier: 'entry',
    name: 'entry',
    description: 'entry',
    apiDescriptions: names.map(name => ({ name, description: `${name} description` })),
    tools: names.map(name => ({ name, description: `${name} description`, parameters: { type: 'object' } })),
    sections: [],
  }]
}

interface Harness {
  agent: Agent
  context: Context
  restrict: ReturnType<typeof vi.fn>
  lift: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
}

function harness(restrictImpl?: () => () => void): Harness {
  const lift = vi.fn()
  const restrict = vi.fn(restrictImpl ?? (() => lift))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
  const agent = { id: 'agent-1', ctx: { tools: { restrict } } } as unknown as Agent
  const context = { tools: { get: vi.fn((name: string) => ({ name })) } } as unknown as Context
  return { agent, context, restrict, lift, warn }
}

describe('createToolHiding', () => {
  it('denies every catalog tool that is not enabled yet', () => {
    const { agent, context, restrict } = harness()
    createToolHiding(context).sync(agent, catalog(['read', 'write', 'bash']), new Set(['read']))

    expect(restrict).toHaveBeenCalledTimes(1)
    expect(restrict).toHaveBeenCalledWith({ deny: ['write', 'bash'] })
  })

  it('keeps the installed restriction while the enabled set is unchanged', () => {
    const { agent, context, restrict, lift } = harness()
    const hiding = createToolHiding(context)
    const tools = catalog(['read', 'write'])

    hiding.sync(agent, tools, new Set(['read']))
    hiding.sync(agent, tools, new Set(['read']))

    expect(restrict).toHaveBeenCalledTimes(1)
    expect(lift).not.toHaveBeenCalled()
  })

  it('lifts the old restriction and reinstalls when a tool becomes enabled', () => {
    const { agent, context, restrict, lift } = harness()
    const hiding = createToolHiding(context)
    const tools = catalog(['read', 'write', 'bash'])

    hiding.sync(agent, tools, new Set(['read']))
    hiding.sync(agent, tools, new Set(['read', 'write']))

    expect(lift).toHaveBeenCalledTimes(1)
    expect(restrict).toHaveBeenCalledTimes(2)
    expect(restrict).toHaveBeenLastCalledWith({ deny: ['bash'] })
  })

  it('reads the catalog past its own restriction and reinstalls it afterwards', () => {
    const { agent, context, restrict, lift } = harness()
    const hiding = createToolHiding(context)
    const tools = catalog(['read', 'write'])

    hiding.sync(agent, tools, new Set(['read']))
    // The directory has to list `write` even though the mask hides it: that is
    // what makes `activate_tools` able to name it at all.
    expect(hiding.readAll(agent, () => 'seen')).toBe('seen')
    expect(lift).toHaveBeenCalledTimes(1)

    hiding.sync(agent, tools, new Set(['read']))
    expect(restrict).toHaveBeenCalledTimes(2)
    expect(restrict).toHaveBeenLastCalledWith({ deny: ['write'] })
  })

  it('lifts the restriction once everything is enabled', () => {
    const { agent, context, restrict, lift } = harness()
    const hiding = createToolHiding(context)
    const tools = catalog(['read', 'write'])

    hiding.sync(agent, tools, new Set(['read']))
    hiding.sync(agent, tools, new Set(['read', 'write']))

    expect(lift).toHaveBeenCalledTimes(1)
    expect(restrict).toHaveBeenCalledTimes(1)
  })

  it('degrades to an untouched surface and warns once when the host refuses the mask', () => {
    const refuse = (): never => {
      throw new Error('unknown global tool "shell"')
    }
    const { agent, context, restrict, warn } = harness(refuse)
    const hiding = createToolHiding(context)
    const tools = catalog(['read', 'shell'])

    expect(() => hiding.sync(agent, tools, new Set())).not.toThrow()
    hiding.sync(agent, catalog(['read']), new Set())

    expect(restrict).toHaveBeenCalledTimes(2)
    const degraded = warn.mock.calls.filter(call => String(call[0]).includes('cannot hide inactive tools'))
    // Once per agent, whatever else the load reported about the same host.
    expect(degraded).toHaveLength(1)
    expect(warn.mock.calls.some(call => String(call[0]).includes('no wrapable tools.view()'))).toBe(true)
  })

  it('lifts the restriction and forgets the agent on disposal', () => {
    const { agent, context, lift } = harness()
    const hiding = createToolHiding(context)

    hiding.sync(agent, catalog(['read']), new Set())
    hiding.forget(agent)

    expect(lift).toHaveBeenCalledTimes(1)
    expect(() => hiding.forget(agent)).not.toThrow()
  })

  it('suspends the restriction so a catalog read sees every tool again', () => {
    const { agent, context, restrict, lift } = harness()
    const hiding = createToolHiding(context)
    const tools = catalog(['read', 'write'])

    hiding.sync(agent, tools, new Set(['read']))
    hiding.suspend(agent)
    hiding.sync(agent, tools, new Set(['read']))

    expect(lift).toHaveBeenCalledTimes(1)
    expect(restrict).toHaveBeenCalledTimes(2)
  })
})
