import type { CollapsibleProps } from './types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Collapsible } from './collapsible'

afterEach(() => {
  cleanup()
})

function renderSection(overrides: Partial<CollapsibleProps> = {}): { onToggle: ReturnType<typeof vi.fn> } {
  const onToggle = vi.fn()
  const props: CollapsibleProps = {
    label: '默认激活工具（2 个）',
    open: false,
    onToggle,
    children: <p>正文</p>,
    ...overrides,
  }
  render(<Collapsible {...props} />)
  return { onToggle }
}

describe('collapsible', () => {
  it('reports its folded state to assistive technology and hides the body', () => {
    renderSection()

    const toggle = screen.getByRole('button', { name: '默认激活工具（2 个）' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const body = toggle.getAttribute('aria-controls')
    expect(body).toBeTruthy()
    expect(document.getElementById(body!)).toHaveProperty('hidden', true)
  })

  it('shows the body and asks to open when it is open already', () => {
    const { onToggle } = renderSection({ open: true })

    const toggle = screen.getByRole('button', { name: '默认激活工具（2 个）' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toHaveProperty('hidden', false)
    expect(screen.getByText('正文')).toBeTruthy()

    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('asks to open a folded section', () => {
    const { onToggle } = renderSection()

    fireEvent.click(screen.getByRole('button', { name: '默认激活工具（2 个）' }))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('keeps header actions outside the toggle button', () => {
    renderSection({ actions: <span>操作</span> })

    const toggle = screen.getByRole('button', { name: '默认激活工具（2 个）' })
    expect(toggle.textContent).not.toContain('操作')
    expect(screen.getByText('操作')).toBeTruthy()
  })
})
