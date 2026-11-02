import type { ActivationCatalog } from '../types'
import type { ConfigurationScope, ConfigurationScopeSnapshot } from './types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    subscribe: () => () => {},
  }
}

function renderPage(scope: ConfigurationScope, load: () => Promise<ActivationCatalog> = async () => CATALOG) {
  return render(<ToolActivatorConfiguration view="page" configScope={scope} loadToolCatalog={load} />)
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
    await waitFor(() => expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['autoGroupMcp'], value: false }], 3))
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

    const read = await screen.findByRole('switch', { name: '默认加载 read' })
    expect(read).toHaveProperty('disabled', false)
    expect(screen.getByText('基础工具')).toBeTruthy()

    read.click()
    await waitFor(() => expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['basicTools'], value: [] }], 3))
    expect(screen.getByText('默认激活工具（0 个）')).toBeTruthy()
    expect(screen.getByText('已安装但需先激活（2 个）')).toBeTruthy()
    const pending = screen.getByRole('switch', { name: '默认加载 read' })
    expect(pending.getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect(pending).toHaveProperty('disabled', false))

    pending.click()
    await waitFor(() => expect(scope.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['basicTools'], value: ['read'] }], 3))
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

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    const read = screen.getByRole('switch', { name: '默认加载 read' })
    expect(mail.getAttribute('aria-checked')).toBe('false')
    expect(read.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('mailbox group')).toBeTruthy()
  })

  it('adds every tool of a group to basicTools when its switch is enabled', async () => {
    const scope = scopeOf({ basicTools: ['read'] })
    renderPage(scope)

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    mail.click()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['basicTools'], value: ['read', 'mcp__mail__send', 'mcp__mail__list'] }],
      3,
    )
  })

  it('removes a group from basicTools when its switch is disabled', async () => {
    const scope = scopeOf({ basicTools: ['read', 'mcp__mail__send', 'mcp__mail__list'] })
    renderPage(scope)

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    expect(mail.getAttribute('aria-checked')).toBe('true')
    mail.click()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['basicTools'], value: ['read'] }], 3)
  })

  it('writes through a platform snapshot that carries no mode field', async () => {
    // Newer platform snapshots dropped `mode`; guarding on it silently refused
    // every write (issue #2).
    const scope = scopeOf({ basicTools: ['read'] })
    expect('mode' in scope.getSnapshot()).toBe(false)
    renderPage(scope)

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    mail.click()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['basicTools'], value: ['read', 'mcp__mail__send', 'mcp__mail__list'] }],
      3,
    ))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('locks the controls when the host document is not writable', async () => {
    const scope = scopeOf({ basicTools: [] }, { writable: false })
    renderPage(scope)

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

  it('keeps a new group local until its identifier can be saved', async () => {
    const scope = scopeOf({ groups: [] })
    renderPage(scope)

    const add = await screen.findByRole('button', { name: '添加分组' })
    add.click()

    // The empty draft never reaches the Host: the config schema rejects it.
    expect(await screen.findByText('未命名分组 1')).toBeTruthy()
    expect(scope.mutate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('标识符'), { target: { value: 'docs' } })

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['groups'], value: [{ identifier: 'docs', name: '', description: '', tools: [], sections: [] }] }],
      3,
    )
  })

  it('coalesces identifier typing into a single write', async () => {
    const scope = scopeOf({ groups: [] })
    renderPage(scope)

    const add = await screen.findByRole('button', { name: '添加分组' })
    add.click()
    await screen.findByText('未命名分组 1')

    const field = screen.getByLabelText('标识符')
    fireEvent.change(field, { target: { value: 'f' } })
    fireEvent.change(field, { target: { value: 'fi' } })
    fireEvent.change(field, { target: { value: 'fil' } })

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['groups'], value: [{ identifier: 'fil', name: '', description: '', tools: [], sections: [] }] }],
      3,
    )
  })
})
