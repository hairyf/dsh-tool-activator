import CssRender from 'css-render'
import { afterEach, describe, expect, it } from 'vitest'
import { CLASSES, STYLE_ID } from './constants'
import { mountToolActivatorStyles } from './styles'

afterEach(() => {
  CssRender().find(STYLE_ID)?.remove()
})

describe('owned css-render style lifecycle', () => {
  it('mounts scoped accessible styles and removes them through its disposer', () => {
    const dispose = mountToolActivatorStyles()
    const mounted = CssRender().find(STYLE_ID)
    expect(mounted).not.toBeNull()
    expect(mounted?.parentNode).toBe(document.head)
    expect(mounted?.textContent).toContain(`.${CLASSES.root}`)
    expect(mounted?.textContent).toContain('focus-visible')
    expect(mounted?.textContent).toContain(':disabled')
    dispose()
    expect(CssRender().find(STYLE_ID)).toBeNull()
    dispose()
    expect(CssRender().find(STYLE_ID)).toBeNull()
  })

  it('never takes ownership of an existing style with the same id', () => {
    const first = mountToolActivatorStyles()
    const original = CssRender().find(STYLE_ID)
    const borrowed = mountToolActivatorStyles()
    borrowed()
    expect(CssRender().find(STYLE_ID)).toBe(original)
    first()
    expect(CssRender().find(STYLE_ID)).toBeNull()
  })

  it('does not remove a replacement installed after its own style was removed', () => {
    const first = mountToolActivatorStyles()
    CssRender().find(STYLE_ID)?.remove()
    const replacementDispose = mountToolActivatorStyles()
    const replacement = CssRender().find(STYLE_ID)
    first()
    expect(CssRender().find(STYLE_ID)).toBe(replacement)
    replacementDispose()
    expect(CssRender().find(STYLE_ID)).toBeNull()
  })
})
