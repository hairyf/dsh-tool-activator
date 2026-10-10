import type { ActivationCatalog } from '../types'
import type { ConfigurationScope, ConfigurationScopeSnapshot } from './types'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolActivatorConfiguration } from './configuration-page'
import { CLASSES } from './constants'

afterEach(() => {
  cleanup()
})

const CATALOG: ActivationCatalog = {
  enabled: true,
  basicTools: ['read'],
  baseTools: ['read'],
  entries: [
    { identifier: 'mcp.mail', name: 'mail', description: 'mailbox group', tools: ['mcp__mail__send', 'mcp__mail__list'] },
    { identifier: 'read', name: 'read', description: 'Read a file from disk', tools: ['read'] },
  ],
}

function scopeOf(value: Record<string, unknown>, overrides: Partial<ConfigurationScopeSnapshot> = {}): ConfigurationScope {
  const snapshot: ConfigurationScopeSnapshot = {
    mode: 'host',
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
  it('writes the plugin default set back when reset is pressed', async () => {
    const scope = scopeOf({ basicTools: ['mcp__mail__send', 'mcp__mail__list'] })
    renderPage(scope)

    const button = await screen.findByRole('button', { name: /恢复默认/ })
    button.click()

    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(1))
    expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['basicTools'], value: ['read'] }], 3)
    expect(await screen.findByText('默认激活工具（1 个）')).toBeTruthy()
  })

  it('shows each tool description instead of repeating its name', async () => {
    renderPage(scopeOf({ basicTools: ['read'] }))

    expect(await screen.findByText('Read a file from disk')).toBeTruthy()
    expect(screen.getByText('mailbox group')).toBeTruthy()
  })

  it('locks the plugin base tools so they cannot be disabled', async () => {
    const scope = scopeOf({ basicTools: ['read'] })
    renderPage(scope)

    const read = await screen.findByRole('switch', { name: '默认加载 read' })
    expect(read).toHaveProperty('disabled', true)
    expect(screen.getByText('基础工具')).toBeTruthy()

    read.click()
    expect(scope.mutate).not.toHaveBeenCalled()
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

  it('refuses to write when the host document is not writable', async () => {
    const scope = scopeOf({ basicTools: [] }, { writable: false })
    renderPage(scope)

    const mail = await screen.findByRole('switch', { name: '默认加载 mail' })
    mail.click()

    expect((await screen.findByRole('alert')).textContent).toBe('当前配置不可写，无法保存。')
    expect(scope.mutate).not.toHaveBeenCalled()
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
})
