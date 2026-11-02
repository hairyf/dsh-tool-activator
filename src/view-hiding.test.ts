import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { installViewHiding } from './view-hiding'

interface FakeView {
  visible: Map<string, unknown>
}

/**
 * The host keeps `view` on the prototype (a plain class method), so the patch has
 * to climb to it. `extra` models a scope-local tool set that registers AFTER the
 * gate is installed — the hashline tools arrive exactly that way.
 */
class FakeTools {
  extra: string[] = []

  view(scope?: unknown): FakeView {
    const names = scope === undefined ? ['read', 'bash', 'ast_grep'] : ['read', 'bash', 'ast_grep', 'write', ...this.extra]
    return { visible: new Map(names.map(name => [name, { name }])) }
  }
}

function agent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('installViewHiding', () => {
  it('keeps only the allowed names for the owning agent and leaves other scopes alone', () => {
    const tools = new FakeTools()
    const hiding = installViewHiding(tools)
    const owner = agent('owner')
    const other = agent('other')

    hiding!.setGate(owner, new Set(['read', 'write']))

    expect([...tools.view(owner).visible.keys()]).toEqual(['read', 'write'])
    expect([...tools.view(other).visible.keys()]).toEqual(['read', 'bash', 'ast_grep', 'write'])
  })

  it('hides agent-scoped registrations too, which tools.restrict() refuses', () => {
    const tools = new FakeTools()
    const hiding = installViewHiding(tools)
    const owner = agent('owner')

    hiding!.setGate(owner, new Set(['read', 'bash', 'write']))

    expect(tools.view(owner).visible.has('ast_grep')).toBe(false)
  })

  it('hides a tool that registers after the gate was installed', () => {
    const tools = new FakeTools()
    const hiding = installViewHiding(tools)
    const owner = agent('owner')

    hiding!.setGate(owner, new Set(['read', 'bash', 'ast_grep', 'write']))
    // Registered by another plugin a moment later: the gate is an allow-list read
    // on every call, so no re-install and no second turn is needed to hide it.
    tools.extra = ['ast_edit', 'undo_last_edit']

    const visible = [...tools.view(owner).visible.keys()]
    expect(visible).not.toContain('ast_edit')
    expect(visible).not.toContain('undo_last_edit')
  })

  it('lets an allowed name stay visible after it re-registers', () => {
    const tools = new FakeTools()
    const hiding = installViewHiding(tools)
    const owner = agent('owner')

    hiding!.setGate(owner, new Set(['read', 'bash', 'ast_grep', 'write']))
    tools.extra = ['bash']

    expect(tools.view(owner).visible.has('bash')).toBe(true)
  })

  it('lifts the gate for one read and puts the same gate back', () => {
    const tools = new FakeTools()
    const hiding = installViewHiding(tools)
    const owner = agent('owner')

    hiding!.setGate(owner, new Set(['read']))
    // The catalog `activate_tools` offers must see every tool, and the gate has to
    // come back afterwards — otherwise the read would also declare everything
    // on the step that follows it.
    expect([...hiding!.transparent(owner, () => [...tools.view(owner).visible.keys()])])
      .toContain('bash')
    expect([...tools.view(owner).visible.keys()]).toEqual(['read'])
  })

  it('suspends and forgets per agent', () => {
    const tools = new FakeTools()
    const hiding = installViewHiding(tools)
    const owner = agent('owner')

    hiding!.setGate(owner, new Set(['read']))
    hiding!.suspend(owner)
    expect(tools.view(owner).visible.has('bash')).toBe(true)

    hiding!.setGate(owner, new Set(['read']))
    hiding!.forget(owner)
    expect(tools.view(owner).visible.has('bash')).toBe(true)
  })

  it('leaves the service untouched for scopes it does not own', () => {
    const tools = new FakeTools()
    installViewHiding(tools)

    expect([...tools.view(agent('stranger')).visible.keys()]).toEqual(['read', 'bash', 'ast_grep', 'write'])
  })

  it('fails closed when the host exposes no view to wrap', () => {
    expect(installViewHiding({ register: () => () => { } })).toBeUndefined()
  })

  it('passes an unfamiliar view shape through instead of throwing', () => {
    // 0.2.0 / 0.2.1 still own the declarations, so they never install a gate —
    // but the wrapper is in place and must not turn their view into a TypeError.
    class LegacyTools {
      view(): unknown {
        return { tools: ['read'] }
      }
    }
    const tools = new LegacyTools()

    expect(installViewHiding(tools)).toBeDefined()
    expect(tools.view()).toEqual({ tools: ['read'] })
  })
})
