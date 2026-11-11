import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { CatalogEntry, CatalogPublication } from './types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { ACTIVATOR_SOURCE_KIND } from './constants'
import { catalogMessages, createCatalogPublisher, removedCatalogEntries } from './injection'

/** An agent whose session carries the given history and can take new messages. */
function fakeAgent(history: UserMessage[] = []): { agent: Agent, land: (message: UserMessage) => void, drop: () => void } {
  const messages = [...history]
  return {
    agent: { session: { deriveMessages: () => messages } } as unknown as Agent,
    land: (message) => {
      messages.push(message)
    },
    drop: () => {
      messages.length = 0
    },
  }
}

function publication(text: string, entries: CatalogEntry[] = [{ name: 'web_search', description: 'Search the web', tools: ['web_search'] }], members: CatalogEntry[] = entries): CatalogPublication {
  return { text, entries, members }
}

function carried(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: ACTIVATOR_SOURCE_KIND, form: 'catalog', entries: [] },
  })
}

describe('createCatalogPublisher', () => {
  it('publishes the catalog as this plugin\'s own message', () => {
    const publisher = createCatalogPublisher()
    const { agent } = fakeAgent()
    publisher.prepare(agent, publication('CATALOG'))

    const message = publisher.publish(agent)

    expect(message?.role).toBe('user')
    expect(message?.source).toEqual({
      kind: ACTIVATOR_SOURCE_KIND,
      form: 'catalog',
      entries: [{ name: 'web_search', description: 'Search the web', tools: ['web_search'] }],
      members: [{ name: 'web_search', description: 'Search the web', tools: ['web_search'] }],
    })
    expect(message?.content).toEqual([{ type: 'text', text: 'CATALOG' }])
  })

  it('does not publish the same catalog twice', () => {
    const publisher = createCatalogPublisher()
    const { agent, land } = fakeAgent()
    publisher.prepare(agent, publication('CATALOG'))

    const message = publisher.publish(agent)
    expect(message).toBeDefined()
    land(message!)

    expect(publisher.publish(agent)).toBeUndefined()
  })

  it('marks a replacement catalog as an update', () => {
    const publisher = createCatalogPublisher()
    const { agent, land } = fakeAgent()
    publisher.prepare(agent, publication('FIRST'))
    land(publisher.publish(agent)!)
    publisher.prepare(agent, publication('SECOND'))

    const message = publisher.publish(agent)

    expect(message?.source).toMatchObject({ update: true })
    expect(message?.content).toEqual([{ type: 'text', text: 'SECOND' }])
  })

  it('adopts the catalog a restored session already carries', () => {
    const publisher = createCatalogPublisher()
    const { agent } = fakeAgent([carried('CATALOG')])
    publisher.prepare(agent, publication('CATALOG'))

    expect(publisher.publish(agent)).toBeUndefined()
  })

  it('publishes again when the session lost the catalog', () => {
    const publisher = createCatalogPublisher()
    const { agent, land, drop } = fakeAgent()
    publisher.prepare(agent, publication('CATALOG'))
    land(publisher.publish(agent)!)
    drop()

    expect(publisher.publish(agent)).toBeDefined()
  })

  it('forgets the catalog when the agent has none to publish', () => {
    const publisher = createCatalogPublisher()
    const { agent } = fakeAgent()
    publisher.prepare(agent, publication('CATALOG'))
    publisher.forget(agent)

    expect(publisher.publish(agent)).toBeUndefined()
  })

  it('finds the catalogs a session carries', () => {
    const message = carried('CATALOG')

    expect(catalogMessages(fakeAgent([message]).agent)).toEqual([message])
  })

  it('names the entries and members that vanished when republishing a shrunken catalog', () => {
    const publisher = createCatalogPublisher()
    const { agent, land } = fakeAgent()
    publisher.prepare(agent, publication('FIRST', [
      { name: 'web_search', description: 'Search the web', tools: ['web_search'] },
      { name: 'files', description: 'File utilities', tools: ['read', 'write'] },
    ]))
    land(publisher.publish(agent)!)
    publisher.prepare(agent, publication('SECOND', [
      { name: 'files', description: 'File utilities', tools: ['read'] },
    ]))

    const message = publisher.publish(agent)

    expect(message?.source).toMatchObject({ update: true, entries: [{ name: 'files', tools: ['read'] }] })
    const text = message?.content[0]?.type === 'text' ? message.content[0].text : ''
    expect(text).toContain('SECOND')
    expect(text).toContain('<removed_tools')
    expect(text).toContain('identifier="web_search" names="web_search"')
    expect(text).toContain('identifier="files" names="write"')
  })

  it('does not name an entry that merely left the discovery list by activation', () => {
    const publisher = createCatalogPublisher()
    const { agent, land } = fakeAgent()
    const files = { name: 'files', description: 'File utilities', tools: ['read', 'write'] }
    publisher.prepare(agent, publication('FIRST', [files], [files]))
    land(publisher.publish(agent)!)
    publisher.prepare(agent, publication('SECOND', [], [files]))

    const message = publisher.publish(agent)

    expect(message?.source).toMatchObject({ update: true })
    const text = message?.content[0]?.type === 'text' ? message.content[0].text : ''
    expect(text).not.toContain('<removed_tools')
  })

  it('does not loop on its own removed-entries tail', () => {
    const publisher = createCatalogPublisher()
    const { agent, land } = fakeAgent()
    publisher.prepare(agent, publication('FIRST', [{ name: 'gone', description: 'Left the catalog', tools: ['x'] }]))
    land(publisher.publish(agent)!)
    publisher.prepare(agent, publication('SECOND', []))
    land(publisher.publish(agent)!)

    expect(publisher.publish(agent)).toBeUndefined()
  })

  it('judges entries without member names at the identifier level only', () => {
    expect(removedCatalogEntries([{ name: 'old', description: 'Legacy entry' } as CatalogEntry], [])).toEqual([
      { identifier: 'old', names: [] },
    ])
  })
})

describe('the release records of a catalog', () => {
  const released = [{ identifier: 'files', names: ['read'], reason: { kind: 'active' as const, text: 'The files are not needed any more' } }]

  it('publishes a catalog with release records even when the bare catalog did not change', () => {
    const publisher = createCatalogPublisher()
    const { agent } = fakeAgent()
    publisher.prepare(agent, { ...publication('CATALOG'), released })

    const message = publisher.publish(agent)
    expect(message?.source).toMatchObject({ released })
  })

  it('compares the catalogs without the released section', () => {
    const publisher = createCatalogPublisher()
    const { agent, land } = fakeAgent()
    publisher.prepare(agent, { text: 'CATALOG\n\n<released_tools>\n  <tool identifier="files" names="read"/>\n</released_tools>', entries: [], members: [], released })
    land(publisher.publish(agent)!)

    // The bare catalog did not change, so the next publication without the
    // increment is not published again.
    publisher.prepare(agent, { text: 'CATALOG', entries: [], members: [] })
    expect(publisher.publish(agent)).toBeUndefined()
  })

  it('compares the catalogs without the released section when it sits in the middle', () => {
    const publisher = createCatalogPublisher()
    const { agent, land } = fakeAgent()
    publisher.prepare(agent, { text: 'CATALOG\n\n<released_tools>\n  <tool identifier="files" names="read"/>\n</released_tools>\n\nDOCS', entries: [], members: [], released })
    land(publisher.publish(agent)!)

    // The bare catalog did not change: the section and the blank line it
    // introduced are gone, so the text reads exactly like a catalog that never
    // carried the section.
    publisher.prepare(agent, { text: 'CATALOG\n\nDOCS', entries: [], members: [] })
    expect(publisher.publish(agent)).toBeUndefined()
  })
})
