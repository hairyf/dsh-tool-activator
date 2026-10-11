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

function renderEditor(groups: ToolGroupDraft[], overrides: Partial<GroupsEditorProps> = {}) {
  const onChange = vi.fn()
  render(<GroupsEditor groups={groups} onChange={onChange} toolNames={TOOL_NAMES} {...overrides} />)
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
})
