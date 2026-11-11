import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { installAdmissionGating } from './admission-gating'

interface FakeToolSet {
  dispose: () => void
  view: (scope?: unknown) => ReadonlyMap<string, unknown>
}

interface FakeContext {
  agent?: Agent
}

/**
 * The host keeps `resolve` on the prototype (a plain class method), so the
 * patch has to climb to it. `extra` models a scope-local tool set that
 * registers AFTER the gate is installed — the hashline tools arrive exactly
 * that way.
 */
class FakeTools {
  extra: string[] = []

  async resolve(context: FakeContext): Promise<FakeToolSet> {
    const names = ['read', 'bash', 'ast_grep', 'write', ...this.extra]
    const visible = new Map(names.map(name => [name, { name }]))
    return {
      dispose: () => { },
      view: (scope?: unknown) => scope === context.agent ? visible : new Map(),
    }
  }

  /** The registry's own face: what every scope reader sees. */
  schemas(scope?: unknown): string[] {
    return scope === undefined ? ['read', 'bash', 'ast_grep'] : ['read', 'bash', 'ast_grep', 'write', ...this.extra]
  }
}

function agent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('installAdmissionGating', () => {
  it('narrows the step admission to the enabled tools', async () => {
    const tools = new FakeTools()
    const gate = installAdmissionGating(tools)!
    const owner = agent('owner')
    gate.setAllowed(owner, new Set(['read', 'write']))

    const toolSet = await tools.resolve({ agent: owner })
    expect([...toolSet.view(owner).keys()]).toEqual(['read', 'write'])
  })

  it('leaves the registry face untouched, so a reader still finds what is registered', async () => {
    const tools = new FakeTools()
    const gate = installAdmissionGating(tools)!
    const owner = agent('owner')
    gate.setAllowed(owner, new Set(['read']))

    // The settings page and every plugin that probes its own registration read
    // the registry. Filtering there made a plugin that registers a per-agent
    // tool read its own registration back as missing.
    expect(tools.schemas(owner)).toContain('bash')
    expect(tools.schemas(owner)).toContain('ast_grep')
  })

  it('hides a tool that registers after the gate was installed', async () => {
    const tools = new FakeTools()
    const gate = installAdmissionGating(tools)!
    const owner = agent('owner')
    gate.setAllowed(owner, new Set(['read', 'write']))
    // Registered by another plugin a moment later: the gate is an allow-list
    // read on every resolution, so no re-install and no second turn is needed.
    tools.extra = ['ast_edit', 'undo_last_edit']

    const toolSet = await tools.resolve({ agent: owner })
    const admitted = [...toolSet.view(owner).keys()]
    expect(admitted).not.toContain('ast_edit')
    expect(admitted).not.toContain('undo_last_edit')
  })

  it('resolves a missing allow-list on the very first resolution, before any assembly', async () => {
    const tools = new FakeTools()
    const gate = installAdmissionGating(tools)!
    const owner = agent('restored')
    const resolve = vi.fn(() => {
      gate.setAllowed(owner, new Set(['read']))
    })
    gate.setResolver(resolve)

    // A step resolves its tool set before it assembles, so the allow-list has to
    // exist on this first resolution — not after an assembly that would install it.
    const toolSet = await tools.resolve({ agent: owner })
    expect([...toolSet.view(owner).keys()]).toEqual(['read'])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('stops resolving once an allow-list exists', async () => {
    const tools = new FakeTools()
    const gate = installAdmissionGating(tools)!
    const owner = agent('settled')
    const resolve = vi.fn()
    gate.setResolver(resolve)
    gate.setAllowed(owner, new Set(['read', 'write']))

    const toolSet = await tools.resolve({ agent: owner })
    expect([...toolSet.view(owner).keys()]).toEqual(['read', 'write'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('leaves an agent it does not manage alone', async () => {
    const tools = new FakeTools()
    const gate = installAdmissionGating(tools)!
    const owner = agent('owner')
    const other = agent('other')
    gate.setAllowed(owner, new Set(['read']))

    // The plugin manages one agent at a time: an agent it has no allow-list for
    // keeps the host's own admission.
    const toolSet = await tools.resolve({ agent: other })
    expect([...toolSet.view(other).keys()]).toEqual(['read', 'bash', 'ast_grep', 'write'])
  })

  it('forgets one agent', async () => {
    const tools = new FakeTools()
    const gate = installAdmissionGating(tools)!
    const owner = agent('owner')
    const resolve = vi.fn(() => {
      gate.setAllowed(owner, new Set(['read']))
    })
    gate.setResolver(resolve)
    gate.setAllowed(owner, new Set(['read']))

    gate.forget(owner)
    const toolSet = await tools.resolve({ agent: owner })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect([...toolSet.view(owner).keys()]).toEqual(['read'])
  })

  it('restores the host own resolve', () => {
    const tools = new FakeTools()
    const original = tools.resolve
    const gate = installAdmissionGating(tools)!
    expect(tools.resolve).not.toBe(original)

    gate.restore()
    expect(tools.resolve).toBe(original)
  })

  it('fails closed when the host exposes no admission', () => {
    expect(installAdmissionGating({ register: () => () => { } })).toBeUndefined()
  })
})
