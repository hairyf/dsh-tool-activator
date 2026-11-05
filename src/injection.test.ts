import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { CatalogPublication } from './types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { ACTIVATOR_SOURCE_KIND } from './constants'
import { catalogMessages, createCatalogPublisher } from './injection'

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

function publication(text: string): CatalogPublication {
  return { text, entries: [{ name: 'web_search', description: 'Search the web' }] }
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
      entries: [{ name: 'web_search', description: 'Search the web' }],
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
})
