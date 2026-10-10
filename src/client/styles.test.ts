import { afterEach, describe, expect, it } from 'vitest'
import { CLASSES, STYLE_TAG_ID } from './constants'
import { mountToolActivatorStyles, ownedStyleTag } from './styles'

afterEach(() => {
  ownedStyleTag()?.remove()
  document.querySelectorAll('style[data-plugin-css]').forEach(tag => tag.remove())
})

describe('owned style tag lifecycle', () => {
  it('mounts one owned tag with scoped accessible rules and removes it through its disposer', () => {
    const dispose = mountToolActivatorStyles()
    const mounted = ownedStyleTag()
    expect(mounted).not.toBeNull()
    expect(mounted?.parentNode).toBe(document.head)
    expect(mounted?.dataset.plugin).toBe('dsh-tool-activator')
    expect(mounted?.dataset.pluginCss).toBe(STYLE_TAG_ID)
    expect(mounted?.textContent).toContain(`.${CLASSES.root}`)
    expect(mounted?.textContent).toContain('focus-visible')
    expect(mounted?.textContent).toContain(':disabled')
    dispose()
    expect(ownedStyleTag()).toBeNull()
    dispose()
    expect(ownedStyleTag()).toBeNull()
  })

  it('never takes ownership of an existing tag with the same plugin id', () => {
    const first = mountToolActivatorStyles()
    const original = ownedStyleTag()
    const borrowed = mountToolActivatorStyles()
    borrowed()
    expect(ownedStyleTag()).toBe(original)
    first()
    expect(ownedStyleTag()).toBeNull()
  })

  it('does not remove a replacement installed after its own tag was removed', () => {
    const first = mountToolActivatorStyles()
    ownedStyleTag()?.remove()
    const replacementDispose = mountToolActivatorStyles()
    const replacement = ownedStyleTag()
    first()
    expect(ownedStyleTag()).toBe(replacement)
    replacementDispose()
    expect(ownedStyleTag()).toBeNull()
  })
})
