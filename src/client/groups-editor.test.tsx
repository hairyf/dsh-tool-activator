import type { GroupsEditorProps, ToolGroupDraft } from './types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GroupsEditor } from './groups-editor'

afterEach(() => {
  cleanup()
})

const TOOL_NAMES = ['read', 'write', 'pwsh']

function group(overrides: Partial<ToolGroupDraft> = {}): ToolGroupDraft {
  return { identifier: 'files', name: 'Files', description: 'File utilities', tools: ['read'], sections: [], ...overrides }
}

/** Group cards start folded, so a row-level test opens them first. */
function openCards(): void {
  for (const toggle of screen.queryAllByRole('button', { expanded: false }))
    fireEvent.click(toggle)
}

function renderEditor(
  groups: ToolGroupDraft[],
  overrides: Partial<GroupsEditorProps> = {},
  options: { expanded?: boolean } = {},
) {
  const onChange = vi.fn()
  render(<GroupsEditor basicTools={[]} lockedTools={[]} groups={groups} onChange={onChange} toolNames={TOOL_NAMES} {...overrides} />)
  if (options.expanded !== false)
    openCards()
  return onChange
}

describe('groups editor', () => {
  it('renders one card per group with its tools checked', () => {
    renderEditor([group({ tools: ['read', 'pwsh'] })])

    expect(screen.getByText('files')).toBeTruthy()
    expect(screen.getByLabelText('read')).toHaveProperty('checked', true)
    expect(screen.getByLabelText('write')).toHaveProperty('checked', false)
    expect(screen.getByLabelText('pwsh')).toHaveProperty('checked', true)
  })

  it('emits an updated draft without mutating the original when a field changes', () => {
    const original = group()
    const onChange = renderEditor([original])

    fireEvent.change(screen.getByLabelText('标识符'), { target: { value: 'docs' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as ToolGroupDraft[]
    expect(next[0]).toEqual({ ...original, identifier: 'docs' })
    expect(original.identifier).toBe('files')
    expect(next[0]).not.toBe(original)
  })

  it('adds and removes tools of a group', () => {
    const onChange = renderEditor([group({ tools: ['read'] })])

    screen.getByLabelText('write').click()
    expect((onChange.mock.calls[0]![0] as ToolGroupDraft[])[0]!.tools).toEqual(['read', 'write'])

    onChange.mockClear()
    screen.getByLabelText('read').click()
    expect((onChange.mock.calls[0]![0] as ToolGroupDraft[])[0]!.tools).toEqual([])
  })

  it('adds a section row and removes it again', () => {
    const onChange = renderEditor([group()])

    screen.getByRole('button', { name: '为第 1 组添加说明节' }).click()
    expect((onChange.mock.calls[0]![0] as ToolGroupDraft[])[0]!.sections).toEqual([''])

    cleanup()
    const remove = renderEditor([group({ sections: ['plugin:files'] })])
    screen.getByRole('button', { name: '删除第 1 组第 1 个说明节' }).click()
    expect((remove.mock.calls[0]![0] as ToolGroupDraft[])[0]!.sections).toEqual([])
  })

  it('appends an empty group from the toolbar', () => {
    const onChange = renderEditor([])

    screen.getByRole('button', { name: '添加分组' }).click()
    expect(onChange.mock.calls[0]![0]).toEqual([{ identifier: '', name: '', description: '', tools: [], sections: [] }])
  })

  it('flags an invalid identifier and a duplicate without blocking the change', () => {
    renderEditor([group({ identifier: 'has space' }), group({ identifier: 'has space' })])

    expect(screen.getAllByText('标识符只能包含字母、数字、下划线、点和连字符。')).toHaveLength(2)
    expect(screen.queryByText(/重复/)).toBeNull()
  })

  it('reports a duplicate identifier on the later card', () => {
    renderEditor([group(), group({ name: 'Second' })])

    expect(screen.getByText('标识符 files 重复，宿主会拒绝保存。')).toBeTruthy()
  })

  it('refuses interaction while disabled', () => {
    const onChange = renderEditor([group()], { disabled: true })

    expect(screen.getByLabelText('标识符')).toHaveProperty('disabled', true)
    screen.getByRole('button', { name: '添加分组' }).click()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('offers only the tools no other owner holds, keeping its own members', () => {
    renderEditor(
      [group({ tools: ['pwsh'] }), group({ identifier: 'audio', tools: ['read'] })],
      { basicTools: ['write'], toolNames: ['read', 'write', 'pwsh'] },
    )

    // The first card keeps its member and hides the other group's tool and the
    // default-loaded one; the second card lists its own member only.
    expect(screen.getByLabelText('pwsh')).toHaveProperty('checked', true)
    expect(screen.getAllByLabelText('read')).toHaveLength(1)
    expect(screen.queryByLabelText('write')).toBeNull()
  })

  it('starts folded and opens a card from its header', () => {
    renderEditor([group()], {}, { expanded: false })

    const toggle = screen.getByRole('button', { name: 'files' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)

    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'files' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryAllByRole('textbox').length).toBeGreaterThan(0)
  })

  it('filters the tools inside a card', () => {
    renderEditor([group({ tools: ['read'] })])

    fireEvent.change(screen.getByPlaceholderText('过滤工具'), { target: { value: 'pw' } })

    expect(screen.queryByLabelText('read')).toBeNull()
    expect(screen.getByLabelText('pwsh')).toBeTruthy()
  })

  it('adds every visible tool at once', () => {
    const onChange = renderEditor([group({ tools: ['read'] })])

    fireEvent.click(screen.getByRole('button', { name: '全选可选工具' }))

    expect((onChange.mock.calls[0]![0] as ToolGroupDraft[])[0]!.tools).toEqual(['read', 'write', 'pwsh'])
  })

  it('adds only the filtered tools when the card is filtered', () => {
    const onChange = renderEditor([group({ tools: ['read'] })])

    fireEvent.change(screen.getByPlaceholderText('过滤工具'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: '全选过滤结果' }))

    expect((onChange.mock.calls[0]![0] as ToolGroupDraft[])[0]!.tools).toEqual(['read', 'pwsh'])
  })

  it('never offers the tool the plugin locks', () => {
    renderEditor(
      [group({ tools: ['read'] })],
      { lockedTools: ['write'], toolNames: ['read', 'write', 'pwsh'] },
    )

    expect(screen.getByLabelText('read')).toHaveProperty('checked', true)
    expect(screen.queryByLabelText('write')).toBeNull()
    expect(screen.getByLabelText('pwsh')).toBeTruthy()
  })

  it('annotates the members a plugin left behind and removes them in one click', () => {
    const onChange = renderEditor(
      [group({ tools: ['read', 'gone'] })],
      { uninstalledTools: ['gone'] },
    )

    expect(screen.getByText('已卸载 1 个：gone（所属插件可能已被移除）')).toBeTruthy()
    expect(document.querySelector('.dsh-tool-activator-choice-missing')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '移除已卸载成员' }))
    expect((onChange.mock.calls[0]![0] as ToolGroupDraft[])[0]!.tools).toEqual(['read'])
  })

  it('keeps a fully-uninstalled group local and says why', () => {
    const onBlocked = vi.fn()
    const onChange = renderEditor(
      [group({ tools: ['gone_a', 'gone_b'] })],
      { uninstalledTools: ['gone_a', 'gone_b'], onBlocked },
    )

    fireEvent.click(screen.getByRole('button', { name: '移除已卸载成员' }))
    expect((onChange.mock.calls[0]![0] as ToolGroupDraft[])[0]!.tools).toEqual([])
    expect(onBlocked.mock.calls[0]![0]).toContain('空分组不会被保存')
  })

  it('does not annotate members while nothing is uninstalled', () => {
    renderEditor([group({ tools: ['read'] })], { uninstalledTools: [] })

    expect(screen.queryByText(/已卸载/)).toBeNull()
    expect(document.querySelector('.dsh-tool-activator-choice-missing')).toBeNull()
  })

  it('disables the removal button while the page is read-only', () => {
    renderEditor([group({ tools: ['read', 'gone'] })], { uninstalledTools: ['gone'], disabled: true })

    expect(screen.getByRole('button', { name: '移除已卸载成员' })).toHaveProperty('disabled', true)
  })
})
