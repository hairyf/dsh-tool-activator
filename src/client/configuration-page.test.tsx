import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_POLICY, MINIMUM_CORE_VERSION } from '../shared'
import { ToolActivatorConfiguration } from './configuration-page'

afterEach(cleanup)

function form(state: Partial<ConfigPageForm['state']> = {}, mutate: ConfigPageForm['mutate'] = vi.fn<ConfigPageForm['mutate']>().mockResolvedValue(true)): ConfigPageForm {
  return {
    state: { status: 'ready', value: { ...DEFAULT_POLICY }, base: undefined, user: undefined, revision: 7, writable: true, mode: 'host', ...state },
    mutate,
  }
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: '保存配置' })
}

describe('accessible official configuration page', () => {
  it('renders labelled controls, semantic form, version floor and security disclaimer', () => {
    render(<ToolActivatorConfiguration view="page" form={form()} />)
    expect(screen.getByRole('heading', { name: '按需工具加载' })).toBeTruthy()
    expect(screen.getByRole('form', { name: '工具激活策略' })).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '启用按需工具加载' }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '激活前请求用户确认' }).checked).toBe(true)
    expect(screen.getByRole('combobox', { name: '加载模式' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '基础工具（每行一个名称）' }).value).toBe(DEFAULT_POLICY.basicTools.join('\n'))
    expect(screen.getByText(/工具展示不等于执行授权/)).toBeTruthy()
    expect(screen.getByText(new RegExp(MINIMUM_CORE_VERSION.replaceAll('.', '\\.'), 'u'))).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
  })

  it('shows summary without a configuration editor', () => {
    render(<ToolActivatorConfiguration view="summary" />)
    expect(screen.getByText(/这不是执行权限授权/)).toBeTruthy()
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('gates loading, missing, unavailable, memory, nonwritable and revisionless owner forms', () => {
    const { rerender } = render(<ToolActivatorConfiguration view="page" />)
    expect(screen.getByRole('status').textContent).toContain('不可用')
    expect(saveButton().disabled).toBe(true)
    for (const state of [
      { status: 'loading' as const },
      { status: 'unavailable' as const },
      { mode: 'memory' as const },
      { writable: false },
      { revision: undefined },
      { value: undefined },
    ]) {
      const owner = form(state)
      rerender(<ToolActivatorConfiguration view="page" form={owner} />)
      expect(saveButton().disabled).toBe(true)
      expect(screen.getByRole('status')).toBeTruthy()
      fireEvent.submit(screen.getByRole('form'))
      expect(owner.mutate).not.toHaveBeenCalled()
    }
  })

  it('describes manual mode as basic-only and disabled policy as unfiltered', () => {
    render(<ToolActivatorConfiguration view="page" form={form()} />)
    fireEvent.change(screen.getByRole('combobox', { name: '加载模式' }), { target: { value: 'manual' } })
    expect(screen.getByText(/手动模式仅向模型提供基础工具，不允许通过本插件激活其他工具/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '启用按需工具加载' }))
    expect(screen.getByText(/关闭时不进行工具展示过滤/)).toBeTruthy()
  })

  it('atomically saves all validated fields through owner mutate with the read revision', async () => {
    const owner = form()
    render(<ToolActivatorConfiguration view="page" form={owner} />)
    fireEvent.change(screen.getByRole('textbox', { name: '基础工具（每行一个名称）' }), { target: { value: 'read\ngrep\nread' } })
    fireEvent.change(screen.getByRole('textbox', { name: '排除工具（每行一个名称）' }), { target: { value: 'pwsh' } })
    fireEvent.change(screen.getByRole('combobox', { name: '加载模式' }), { target: { value: 'manual' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    expect(owner.mutate).toHaveBeenCalledOnce()
    expect(owner.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['mode'], value: 'manual' },
      { op: 'set', path: ['basicTools'], value: ['read', 'grep'] },
      { op: 'set', path: ['excludedTools'], value: ['pwsh'] },
      { op: 'set', path: ['requireApproval'], value: true },
      { op: 'set', path: ['autoGroupMcp'], value: true },
      { op: 'set', path: ['groups'], value: [] },
      { op: 'set', path: ['sectionTools'], value: {} },
    ], 7)
    expect(screen.getByRole('status').textContent).toContain('配置已保存')
  })

  it('rejects invalid advanced JSON with a visible alert without writing', async () => {
    const owner = form()
    render(<ToolActivatorConfiguration view="page" form={owner} />)
    fireEvent.click(screen.getByText('高级：显式分组与说明节依赖'))
    fireEvent.change(screen.getByLabelText('工具分组（JSON 数组）'), { target: { value: '[' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    expect(screen.getByRole('alert').textContent).toContain('不是有效 JSON')
    expect(owner.mutate).not.toHaveBeenCalled()
  })

  it('shows host refusal and transport failures without optimistic success', async () => {
    const mutate = vi.fn<ConfigPageForm['mutate']>().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('transport lost'))
    render(<ToolActivatorConfiguration view="page" form={form({}, mutate)} />)
    await act(async () => {
      fireEvent.click(saveButton())
    })
    expect(screen.getByRole('alert').textContent).toContain('宿主未接受保存')
    expect(saveButton().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(saveButton())
    })
    expect(screen.getByRole('alert').textContent).toContain('transport lost')
    expect(screen.queryByText(/配置已保存/)).toBeNull()
  })

  it('disables repeated writes and ignores a stale rejection after owner replacement', async () => {
    let reject: (error: Error) => void = () => {
      throw new Error('Pending mutation was not created')
    }
    const oldMutate = vi.fn<ConfigPageForm['mutate']>().mockImplementation(() => new Promise<boolean>((_resolve, rejectPromise) => {
      reject = rejectPromise
    }))
    const { rerender } = render(<ToolActivatorConfiguration view="page" form={form({}, oldMutate)} />)
    fireEvent.click(saveButton())
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存中…' }).disabled).toBe(true)
    fireEvent.submit(screen.getByRole('form'))
    expect(oldMutate).toHaveBeenCalledOnce()
    const replacement = form({ revision: 12, value: { ...DEFAULT_POLICY, mode: 'manual' } })
    rerender(<ToolActivatorConfiguration view="page" form={replacement} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '加载模式' }).value).toBe('manual')
    await act(async () => {
      reject(new Error('stale failure'))
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('ignores completion after losing host write access', async () => {
    let resolve: (result: boolean) => void = () => {
      throw new Error('Pending mutation was not created')
    }
    const mutate = vi.fn<ConfigPageForm['mutate']>().mockImplementation(() => new Promise<boolean>((resolvePromise) => {
      resolve = resolvePromise
    }))
    const owner = form({}, mutate)
    const { rerender } = render(<ToolActivatorConfiguration view="page" form={owner} />)
    fireEvent.click(saveButton())
    rerender(<ToolActivatorConfiguration view="page" form={form({ writable: false }, mutate)} />)
    await act(async () => {
      resolve(true)
      await Promise.resolve()
    })
    expect(screen.queryByText(/配置已保存/)).toBeNull()
    expect(saveButton().disabled).toBe(true)
  })

  it('consumes transport rejection without publishing after unmount', async () => {
    let reject: (error: Error) => void = () => {
      throw new Error('Pending mutation was not created')
    }
    const mutate = vi.fn<ConfigPageForm['mutate']>().mockImplementation(() => new Promise<boolean>((_resolve, rejectPromise) => {
      reject = rejectPromise
    }))
    const { unmount } = render(<ToolActivatorConfiguration view="page" form={form({}, mutate)} />)
    fireEvent.click(saveButton())
    unmount()
    await act(async () => {
      reject(new Error('closed'))
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('restores the latest host snapshot without sending a mutation', () => {
    const owner = form()
    const { rerender } = render(<ToolActivatorConfiguration view="page" form={owner} />)
    fireEvent.change(screen.getByRole('textbox', { name: '基础工具（每行一个名称）' }), { target: { value: 'write' } })
    fireEvent.click(screen.getByRole('button', { name: '放弃未保存更改' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '基础工具（每行一个名称）' }).value).toBe(DEFAULT_POLICY.basicTools.join('\n'))
    rerender(<ToolActivatorConfiguration view="page" form={form({ revision: 8, value: { ...DEFAULT_POLICY, basicTools: ['glob'] } }, owner.mutate)} />)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '基础工具（每行一个名称）' }).value).toBe('glob')
    expect(owner.mutate).not.toHaveBeenCalled()
  })
})
