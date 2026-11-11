import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { CatalogPublication, CatalogPublisher } from './types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ACTIVATOR_SOURCE_KIND, CATALOG_FORM } from './constants'

/**
 * Publish the tool catalog as this plugin's own message.
 *
 * The catalog changes whenever the enabled tools change, so it is republished
 * rather than patched in place: the message states that it supersedes the
 * earlier one, and the host appends it after the cached history instead of
 * rewriting the system prompt.
 *
 * What the model already holds is read back from the session rather than
 * remembered: a step that dropped the message, or a compaction that replaced
 * it, must not leave the model without a catalog.
 */
export function createCatalogPublisher(): CatalogPublisher {
  const prepared = new WeakMap<Agent, CatalogPublication>()
  return {
    prepare(agent, catalog) {
      prepared.set(agent, catalog)
    },
    forget(agent) {
      prepared.delete(agent)
    },
    publish(agent) {
      const catalog = prepared.get(agent)
      if (catalog === undefined)
        return undefined
      const published = publishedCatalogText(agent)
      if (published === catalog.text)
        return undefined
      return createUserMessage({
        content: [{ type: 'text', text: catalog.text }],
        source: {
          kind: ACTIVATOR_SOURCE_KIND,
          form: CATALOG_FORM,
          entries: catalog.entries,
          ...(published === undefined ? {} : { update: true as const }),
        },
      })
    },
  }
}

/**
 * The catalogs this plugin published to the agent, in the order they landed.
 */
export function catalogMessages(agent: Agent): UserMessage[] {
  return agent.session.deriveMessages().filter((message): message is UserMessage => message.role === 'user' && message.source.kind === ACTIVATOR_SOURCE_KIND)
}

/**
 * The catalog this session's history still carries.
 *
 * A restored session keeps the message it published before the restart, and a
 * compaction may replace it: the publisher reads the session instead of
 * remembering, so a catalog that left the history is published again.
 */
function publishedCatalogText(agent: Agent): string | undefined {
  const messages = catalogMessages(agent)
  const [block] = messages[messages.length - 1]?.content ?? []
  return block?.type === 'text' ? block.text : undefined
}
