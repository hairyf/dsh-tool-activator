import type { ActivationCatalog } from '../types'
import type { ConfigurationScope, ConfigurationScopeSnapshot } from './types'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolActivatorConfiguration } from './configuration-page'
import { CLASSES } from './constants'

afterEach(() => {
  cleanup()
})

const CATALOG: ActivationCatalog = {
  autoGroupMcp: true,
  basicTools: ['read'],
  baseTools: ['read'],
  entries: [
    { identifier: 'mcp.mail', name: 'mail', description: 'mailbox group', tools: ['mcp__mail__send', 'mcp__mail__list'] },
    { identifier: 'read', name: 'read', description: 'Read a file from disk', tools: ['read'] },
  ],
  groups: [],
  requireApproval: true,
}

function scopeOf(value: Record<string, unknown>, overrides: Partial<ConfigurationScopeSnapshot> = {}): ConfigurationScope {
  const snapshot: ConfigurationScopeSnapshot = {
    revision: 3,
    status: 'ready',
    value,
    writable: true,
    ...overrides,
  }
  return {
    getSnapshot: () => snapshot,
    mutate: vi.fn(async () => true),
    subscribe: () => () => { },
  }
}

function renderPage(scope: ConfigurationScope, load: () => Promise<ActivationCatalog> = async () => CATALOG) {
  return render(<ToolActivatorConfiguration view="page" configScope={scope} loadToolCatalog={load} />)
}

/** A catalog with several switches to click, so a burst of picks crosses a write. */
const THREE: ActivationCatalog = {
  autoGroupMcp: true,
  baseTools: ['read'],
  basicTools: ['read'],
  entries: [
    { identifier: 'read', name: 'read', description: 'Read a file from disk', tools: ['read'] },
    { identifier: 'mail', name: 'mail', description: 'mailbox group', tools: ['mcp__mail__send', 'mcp__mail__list'] },
    { identifier: 'zeta', name: 'zeta', description: 'zeta tool', tools: ['zeta'] },
  ],
  groups: [],
  requireApproval: true,
}

interface ControlledScope {
  scope: ConfigurationScope
  /** Resolve the oldest in-flight write, as the Host eventually would. */
  settle: (accepted: boolean) => void
}

/** A scope whose writes stay in flight until the test settles them. */
function controlledScope(value: Record<string, unknown>): ControlledScope {
  const waiting: Array<(accepted: boolean) => void> = []
  return {
    scope: {
      getSnapshot: () => ({ revision: 3, status: 'ready', value, writable: true }),
      mutate: vi.fn(() => new Promise<boolean>((resolve) => {
        waiting.push(resolve)
      })),
      subscribe: () => () => { },
    },
    settle: (accepted: boolean) => {
      waiting.shift()?.(accepted)
    },
  }
}

/** Both tool lists start folded; a test that touches their rows opens them. */
async function openToolLists(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^默认激活工具/ }))
  fireEvent.click(screen.getByRole('button', { name: /^已安装但需先激活/ }))
}

/** A scope somebody else can write to, as the model does through the grouping tool. */
function liveScope(value: Record<string, unknown>): { scope: ConfigurationScope, hostWrites: (next: Record<string, unknown>) => void } {
  let snapshot: ConfigurationScopeSnapshot = { revision: 3, status: 'ready', value, writable: true }
  const listeners = new Set<() => void>()
  return {
    scope: {
      getSnapshot: () => snapshot,
      mutate: vi.fn(async () => true),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    hostWrites: (next: Record<string, unknown>) => {
      snapshot = { ...snapshot, revision: (snapshot.revision ?? 0) + 1, value: next }
      for (const listener of listeners)
        listener()
    },
  }
}

describe('tool configuration page', () => {
  it('pins only the activator regardless of the configured defaults', async () => {
    const custom: ActivationCatalog = {
      autoGroupMcp: true,
      baseTools: ['activate_tools', 'read'],
      basicTools: ['read'],
      entries: [
        { identifier: 'activate_tools', name: 'activate_tools', description: 'Enable tools on demand', tools: ['activate_tools'] },
        { identifier: 'read', name: 'read', description: 'Read a file', tools: ['read'] },
        { identifier: 'pwsh', name: 'pwsh', description: 'Run the shell', tools: ['pwsh'] },
      ],
      groups: [],
      requireApproval: true,
    }
    const scope = scopeOf({ basicTools: [] })
    renderPage(scope, async () => custom)
    await openToolLists()

    expect(await screen.findByText('默认激活工具（1 个）')).toBeTruthy()
    const activator = screen.getByRole('switch', { name: '默认加载 activate_tools' })
    expect(activator).toHaveProperty('disabled', true)
    expect(activator.getAttribute('aria-checked')).toBe('true')
    activator.click()
    expect(scope.mutate).not.toHaveBeenCalled()
    const read = screen.getByRole('switch', { name: '默认加载 read' })
    expect(read).toHaveProperty('disabled', false)
    expect(read.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('已安装但需先激活（2 个）')).toBeTruthy()
  })

  it('lists the base tools before the tools the user added to the defaults', async () => {
    const custom: ActivationCatalog = {
      autoGroupMcp: true,
      baseTools: ['read'],
      basicTools: ['read', 'mcp__mail__send', 'mcp__mail__list', 'zeta'],
      entries: [
        { identifier: 'zeta', name: 'zeta', description: 'zeta tool', tools: ['zeta'] },
        { identifier: 'read', name: 'read', description: 'Read a file', tools: ['read'] },
        { identifier: 'mcp.mail', name: 'mail', description: 'mailbox group', tools: ['mcp__mail__send', 'mcp__mail__list'] },
      ],
      groups: [],
      requireApproval: true,
    }
    renderPage(scopeOf({ basicTools: custom.basicTools }), async () => custom)
    await openToolLists()

    const names = (await screen.findAllByRole('listitem')).map(item => item.textContent)
    const toolRows = names.filter(name => name?.includes('mail') || name?.includes('zeta') || name?.includes('read'))
    expect(toolRows[0]).toContain('read')
    expect(toolRows[1]).toContain('mail')
    expect(toolRows[2]).toContain('zeta')
  })

  it('shows the kept behaviour settings and writes them back', async () => {
    const scope = scopeOf({ basicTools: ['read'] })
    renderPage(scope)

    const approval = await screen.findByRole('switch', { name: '激活前确认' })
    const mcp = screen.getByRole('switch', { name: '按 MCP 服务分组' })
    expect(approval.getAttribute('aria-checked')).toBe('true')
    expect(mcp.getAttribute('aria-checked')).toBe('true')

    mcp.click()
    await waitFor(() => expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['autoGroupMcp'], value: false }]))
    expect(screen.getAllByTitle(/MCP/).length).toBeGreaterThan(0)
  })

  it('shows each tool description instead of repeating its name', async () => {
    renderPage(scopeOf({ basicTools: ['read'] }))

    expect(await screen.findByText('Read a file from disk')).toBeTruthy()
    expect(screen.getByText('mailbox group')).toBeTruthy()
  })

  it('allows a base tool to be disabled and enabled again', async () => {
    const scope = scopeOf({ basicTools: ['read'] })
    renderPage(scope)
    await openToolLists()

    const read = await screen.findByRole('switch', { name: '默认加载 read' })
    expect(read).toHaveProperty('disabled', false)
    expect(screen.getByText('基础工具')).toBeTruthy()

    read.click()
    await waitFor(() => expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['basicTools'], value: [] }]))
    expect(screen.getByText('默认激活工具（0 个）')).toBeTruthy()
    expect(screen.getByText('已安装但需先激活（2 个）')).toBeTruthy()
    const pending = screen.getByRole('switch', { name: '默认加载 read' })
    expect(pending.getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect(pending).toHaveProperty('disabled', false))

    pending.click()
    await waitFor(() => expect(scope.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['basicTools'], value: ['read'] }]))
    expect(screen.getByText('默认激活工具（1 个）')).toBeTruthy()
    expect(screen.getByRole('switch', { name: '默认加载 read' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('splits the catalog into default-activated and pending sections with counts', async () => {
    renderPage(scopeOf({ basicTools: ['read'] }))

    expect(await screen.findByText('默认激活工具（1 个）')).toBeTruthy()
    expect(screen.getByText('已安装但需先激活（1 个）')).toBeTruthy()
  })

  it('moves a group into the default-activated section as soon as its switch is enabled', async () => {
    renderPage(scopeOf({ basicTools: ['read'] }))
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    mail.click()

    expect(await screen.findByText('默认激活工具（2 个）')).toBeTruthy()
    expect(screen.getByText('已安装但需先激活（0 个）')).toBeTruthy()
    expect(screen.getByText('全部工具都已默认激活。')).toBeTruthy()
  })

  it('seeds the default-loaded set from the host policy when the document has no basicTools', async () => {
    renderPage(scopeOf({}))

    expect(await screen.findByText('默认激活工具（1 个）')).toBeTruthy()
    expect(screen.getByText('已安装但需先激活（1 个）')).toBeTruthy()
  })

  it('lists every catalog entry with the switch reflecting the default-loaded set', async () => {
    renderPage(scopeOf({ basicTools: ['read'] }))
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    const read = screen.getByRole('switch', { name: '默认加载 read' })
    expect(mail.getAttribute('aria-checked')).toBe('false')
    expect(read.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('mailbox group')).toBeTruthy()
  })

  it('adds every tool of a group to basicTools when its switch is enabled', async () => {
    const scope = scopeOf({ basicTools: ['read'] })
    renderPage(scope)
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    mail.click()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['basicTools'], value: ['read', 'mcp__mail__send', 'mcp__mail__list'] }],
    )
  })

  it('removes a group from basicTools when its switch is disabled', async () => {
    const scope = scopeOf({ basicTools: ['read', 'mcp__mail__send', 'mcp__mail__list'] })
    renderPage(scope)
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    expect(mail.getAttribute('aria-checked')).toBe('true')
    mail.click()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['basicTools'], value: ['read'] }])
  })

  it('writes through a platform snapshot that carries no mode field', async () => {
    // Newer platform snapshots dropped `mode`; guarding on it silently refused
    // every write (issue #2).
    const scope = scopeOf({ basicTools: ['read'] })
    expect('mode' in scope.getSnapshot()).toBe(false)
    renderPage(scope)
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    mail.click()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['basicTools'], value: ['read', 'mcp__mail__send', 'mcp__mail__list'] }],
    ))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('locks the controls when the host document is not writable', async () => {
    const scope = scopeOf({ basicTools: [] }, { writable: false })
    renderPage(scope)
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    expect(mail).toHaveProperty('disabled', true)
    mail.click()

    expect(scope.mutate).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a catalog failure instead of rendering an empty list', async () => {
    renderPage(scopeOf({ basicTools: [] }), async () => {
      throw new Error('连接服务不可用，无法读取工具列表。')
    })

    expect((await screen.findByRole('alert')).textContent).toBe('连接服务不可用，无法读取工具列表。')
  })

  it('renders a one-liner for the summary view', () => {
    const { container } = render(
      <ToolActivatorConfiguration view="summary" configScope={scopeOf({})} loadToolCatalog={async () => CATALOG} />,
    )
    expect(container.querySelector(`.${CLASSES.list}`)).toBeNull()
    expect(container.textContent).toContain('默认只提供基础工具')
  })

  it('keeps a new group local until it can be saved', async () => {
    const scope = scopeOf({ groups: [] })
    renderPage(scope)

    const add = await screen.findByRole('button', { name: '添加分组' })
    add.click()

    // The empty draft never reaches the Host: the config schema rejects it.
    expect(await screen.findByText('未命名分组 1')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('标识符'), { target: { value: 'docs' } })
    // A group without tools is refused as well, so the draft stays local.
    expect(scope.mutate).not.toHaveBeenCalled()

    screen.getByLabelText('mcp__mail__send').click()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['groups'], value: [{ identifier: 'docs', name: '', description: '', tools: ['mcp__mail__send'], sections: [] }] },
    ])
  })

  it('coalesces identifier typing into a single write', async () => {
    const scope = scopeOf({ groups: [{ identifier: 'fil', name: '', description: '', tools: ['read'], sections: [] }] })
    renderPage(scope)

    const field = await screen.findByLabelText('标识符')
    fireEvent.change(field, { target: { value: 'fi' } })
    fireEvent.change(field, { target: { value: 'fil' } })
    fireEvent.change(field, { target: { value: 'file' } })

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['groups'], value: [{ identifier: 'file', name: '', description: '', tools: ['read'], sections: [] }] },
    ])
  })

  it('keeps every tool picked in a group that is still waiting to be written', async () => {
    const scope = scopeOf({ groups: [{ identifier: 'files', name: 'Files', description: '', tools: ['read'], sections: [] }] })
    renderPage(scope)

    // Picks inside the debounce window all land in the same draft.
    const send = await screen.findByLabelText('mcp__mail__send')
    send.click()
    screen.getByLabelText('mcp__mail__list').click()

    expect(screen.getByLabelText('mcp__mail__send')).toHaveProperty('checked', true)
    expect(screen.getByLabelText('mcp__mail__list')).toHaveProperty('checked', true)

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['groups'],
      value: [{ identifier: 'files', name: 'Files', description: '', tools: ['read', 'mcp__mail__send', 'mcp__mail__list'], sections: [] }],
    }])
  })

  it('keeps a pick made while an earlier write is still in flight', async () => {
    const { scope, settle } = controlledScope({ basicTools: ['read'] })
    renderPage(scope, async () => THREE)
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    fireEvent.click(mail)
    expect(scope.mutate).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('switch', { name: '默认加载 zeta' }))

    // The draft already carries both picks while the first write is unresolved.
    expect(screen.getByRole('switch', { name: '默认加载 mail' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: '默认加载 zeta' }).getAttribute('aria-checked')).toBe('true')
    expect(scope.mutate).toHaveBeenCalledTimes(1)

    settle(true)
    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(2))
    expect(scope.mutate).toHaveBeenLastCalledWith([{
      op: 'set',
      path: ['basicTools'],
      value: ['read', 'mcp__mail__send', 'mcp__mail__list', 'zeta'],
    }])
    settle(true)
  })

  it('merges every field dirtied during a flight into the next write', async () => {
    const { scope, settle } = controlledScope({ basicTools: ['read'] })
    renderPage(scope, async () => THREE)
    await openToolLists()

    await screen.findByRole('switch', { name: '默认加载 mail' })
    fireEvent.click(screen.getByRole('switch', { name: '默认加载 mail' }))
    fireEvent.click(screen.getByRole('switch', { name: '默认加载 zeta' }))
    fireEvent.click(screen.getByRole('switch', { name: '按 MCP 服务分组' }))

    settle(true)

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(2))
    expect(scope.mutate).toHaveBeenLastCalledWith([
      { op: 'set', path: ['basicTools'], value: ['read', 'mcp__mail__send', 'mcp__mail__list', 'zeta'] },
      { op: 'set', path: ['autoGroupMcp'], value: false },
    ])
    settle(true)
  })

  it('rolls the draft back to the saved document when the Host refuses', async () => {
    const scope: ConfigurationScope = {
      getSnapshot: () => ({ revision: 3, status: 'ready', value: { basicTools: ['read'] }, writable: true }),
      mutate: vi.fn(async () => false),
      subscribe: () => () => { },
    }
    renderPage(scope, async () => THREE)
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    fireEvent.click(mail)
    expect(screen.getByRole('switch', { name: '默认加载 mail' }).getAttribute('aria-checked')).toBe('true')

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('宿主拒绝了本次修改'))
    expect(screen.getByRole('switch', { name: '默认加载 mail' }).getAttribute('aria-checked')).toBe('false')
  })

  it('reports a throwing write and restores the saved document', async () => {
    const scope: ConfigurationScope = {
      getSnapshot: () => ({ revision: 3, status: 'ready', value: { basicTools: ['read'] }, writable: true }),
      mutate: vi.fn(async () => {
        throw new Error('连接已断开。')
      }),
      subscribe: () => () => { },
    }
    renderPage(scope, async () => THREE)
    await openToolLists()

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    mail.click()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('连接已断开。'))
    expect(screen.getByRole('switch', { name: '默认加载 mail' }).getAttribute('aria-checked')).toBe('false')
  })

  it('writes a debounced group edit when the page goes away', async () => {
    const scope = scopeOf({ groups: [{ identifier: 'files', name: 'Files', description: '', tools: ['read'], sections: [] }] })
    const { unmount } = renderPage(scope)

    const send = await screen.findByLabelText('mcp__mail__send')
    send.click()
    unmount()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
  })

  it('starts with both tool lists folded and opens one on demand', async () => {
    renderPage(scopeOf({ basicTools: ['read'] }))

    const active = await screen.findByRole('button', { name: '默认激活工具（1 个）' })
    expect(active.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('switch', { name: '默认加载 read' })).toBeNull()

    fireEvent.click(active)
    expect(screen.getByRole('button', { name: '默认激活工具（1 个）' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('switch', { name: '默认加载 read' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '默认激活工具（1 个）' }))
    expect(screen.queryByRole('switch', { name: '默认加载 read' })).toBeNull()
  })

  it('folds a list without writing anything', async () => {
    const scope = scopeOf({ basicTools: ['read'] })
    renderPage(scope)

    fireEvent.click(await screen.findByRole('button', { name: /^已安装但需先激活/ }))

    // Folding is a view preference, so it never becomes a configuration write.
    expect(scope.mutate).not.toHaveBeenCalled()
  })

  it('never offers a default-loaded tool as a group choice', async () => {
    const scope = scopeOf({
      basicTools: ['read'],
      groups: [{ identifier: 'files', name: 'Files', description: '', tools: ['mcp__mail__send'], sections: [] }],
    })
    renderPage(scope)

    // Wait for the catalog so this is about the list, not about timing.
    expect(await screen.findByLabelText('mcp__mail__send')).toHaveProperty('checked', true)
    expect(screen.queryByLabelText('read')).toBeNull()
  })

  it('takes a tool out of every other card once one card claims it', async () => {
    const scope = scopeOf({
      groups: [
        { identifier: 'files', name: 'Files', description: '', tools: ['mcp__mail__send'], sections: [] },
        { identifier: 'audio', name: 'Audio', description: '', tools: [], sections: [] },
      ],
    })
    renderPage(scope)

    // Both cards may still take the free tool.
    expect(await screen.findAllByLabelText('mcp__mail__list')).toHaveLength(2)

    fireEvent.click(screen.getAllByLabelText('mcp__mail__list')[0]!)

    // The other card loses it the moment the first one lists it.
    expect(screen.getAllByLabelText('mcp__mail__list')).toHaveLength(1)
  })

  it('folds every group card but opens the one just added', async () => {
    renderPage(scopeOf({ groups: [{ identifier: 'files', name: 'Files', description: '', tools: ['read'], sections: [] }] }))

    const existing = await screen.findByRole('button', { name: 'files' })
    expect(existing.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: '添加分组' }))

    expect(screen.getByRole('button', { name: '未命名分组 2' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'files' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('never offers the activator as a group choice', async () => {
    const custom: ActivationCatalog = {
      autoGroupMcp: true,
      baseTools: ['activate_tools', 'read'],
      basicTools: ['read'],
      entries: [
        { identifier: 'activate_tools', name: 'activate_tools', description: 'Enable tools on demand', tools: ['activate_tools'] },
        { identifier: 'read', name: 'read', description: 'Read a file', tools: ['read'] },
        { identifier: 'group_tools', name: 'group_tools', description: 'Organize the groups', tools: ['group_tools'] },
      ],
      groups: [],
      requireApproval: true,
    }
    const scope = scopeOf({ groups: [{ identifier: 'files', name: 'Files', description: '', tools: ['read'], sections: [] }] })
    renderPage(scope, async () => custom)

    // The page pins the tools that define the catalog, so no group may bundle them.
    expect(await screen.findByLabelText('read')).toBeTruthy()
    expect(screen.queryByLabelText('activate_tools')).toBeNull()
    expect(screen.queryByLabelText('group_tools')).toBeNull()
  })

  it('reloads the catalog once a group write lands', async () => {
    const scope = scopeOf({ groups: [{ identifier: 'files', name: 'Files', description: '', tools: ['read'], sections: [] }] })
    const load = vi.fn()
      .mockResolvedValueOnce(CATALOG)
      .mockResolvedValueOnce({
        ...CATALOG,
        entries: [...CATALOG.entries, { identifier: 'files', name: 'files', description: 'file group', tools: ['read'] }],
      })
    renderPage(scope, load)

    fireEvent.change(await screen.findByLabelText('标识符'), { target: { value: 'files2' } })

    // The saved group is a new catalog entry, which the page only sees after
    // reading the Host again.
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(await screen.findByText('file group')).toBeTruthy()
  })

  it('re-reads the catalog when the grouping is changed behind the page', async () => {
    const { scope, hostWrites } = liveScope({ groups: [] })
    const load = vi.fn().mockResolvedValue(CATALOG)
    renderPage(scope, load)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))

    // The grouping tool writes the document: the two tool lists now miss every
    // entry that belongs to the new group.
    act(() => {
      hostWrites({ groups: [{ identifier: 'files', name: 'Files', description: '', tools: ['read'], sections: [] }] })
    })

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })

  it('does not re-read the catalog for a change that leaves the grouping alone', async () => {
    const { scope, hostWrites } = liveScope({ basicTools: ['read'], groups: [] })
    const load = vi.fn().mockResolvedValue(CATALOG)
    renderPage(scope, load)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))

    act(() => {
      hostWrites({ basicTools: ['read', 'write'], groups: [] })
    })

    // The entry set did not move, so the tool lists the page already has are still right.
    expect(load).toHaveBeenCalledTimes(1)
  })
})
