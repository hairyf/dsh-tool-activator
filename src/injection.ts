import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { CatalogEntry, CatalogPublication, CatalogPublisher } from './types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ACTIVATOR_SOURCE_KIND, CATALOG_FORM } from './constants'
import { stripReleasedTools } from './prompt'

/**
 * 头标记：重发目录时追加的「已消失条目」段。读回上一条已发布消息时从这个
 * 标记起全部裁掉，正文比较始终发生在两份裸目录之间，不会自己套自己。
 */
const REMOVED_SECTION_HEAD = '<removed_tools'

/** 本次发布相对上次少掉的条目，或某条目里少掉的成员。 */
export interface RemovedCatalogEntry {
  identifier: string
  names: string[]
}

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
      const published = publishedCatalog(agent)
      const released = catalog.released ?? []
      // 「消失」只认全量成员表：条目被激活后离开的是可选目录，全量表里它还
      // 在，不会误报成已卸载。旧版本消息没有 members，退化为不点名。
      const removed = published?.members === undefined ? [] : removedCatalogEntries(published.members, catalog.members)
      // 裸目录之间的相等比较让未变化的目录不再重发：released 段是本目录状态
      // 之上的增量、removed 段是追加的点名，都不参与比较。released 非空必须
      // 发布——模型得知道哪些工具离开了它的工具面。
      if (released.length === 0 && removed.length === 0 && published !== undefined && published.core === stripReleasedTools(catalog.text))
        return undefined
      const text = removed.length === 0 ? catalog.text : `${catalog.text}\n\n${removedSection(removed)}`
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: ACTIVATOR_SOURCE_KIND,
          form: CATALOG_FORM,
          entries: catalog.entries,
          members: catalog.members,
          ...(released.length > 0 ? { released } : {}),
          ...(published === undefined ? {} : { update: true as const }),
        },
      })
      // The records were published: they are not news any more.
      prepared.set(agent, { ...catalog, released: [] })
      return message
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
 * 读回这个会话历史里最后一条目录：正文裁掉「已消失」与「已释放」两段（裸目
 * 录），条目取自消息 source。恢复的会话带着重启前发布的消息、compaction 可能
 * 换掉它，publisher 因此读会话而不是自己记，离开历史的目录会被重新发布。
 */
function publishedCatalog(agent: Agent): { core: string, entries: readonly CatalogEntry[], members: readonly CatalogEntry[] | undefined } | undefined {
  const messages = catalogMessages(agent)
  const last = messages[messages.length - 1]
  const [block] = last?.content ?? []
  // 读回的 source 是全平台宽类型；目录消息在本插件注册的 source 集合里，先按 kind 收窄。
  if (block?.type !== 'text' || last === undefined)
    return undefined
  const { source } = last
  if (source.kind !== ACTIVATOR_SOURCE_KIND)
    return undefined
  const at = block.text.indexOf(REMOVED_SECTION_HEAD)
  return {
    core: stripReleasedTools(at < 0 ? block.text : block.text.slice(0, at).trimEnd()),
    entries: 'form' in source ? source.entries : [],
    members: 'members' in source ? source.members : undefined,
  }
}

/** 旧会话的条目可能没带成员名，这一层只按标识符判定。 */
function memberNames(entry: CatalogEntry): readonly string[] {
  return Array.isArray(entry.tools) ? entry.tools : []
}

/**
 * 相对上一次发布少掉的部分：整个条目消失记整条，条目还在但成员变少只记
 * 少掉的成员名。
 */
export function removedCatalogEntries(previous: readonly CatalogEntry[], current: readonly CatalogEntry[]): RemovedCatalogEntry[] {
  const surviving = new Map(current.map(entry => [entry.name, entry]))
  const removed: RemovedCatalogEntry[] = []
  for (const entry of previous) {
    const next = surviving.get(entry.name)
    if (next === undefined) {
      removed.push({ identifier: entry.name, names: [...memberNames(entry)] })
      continue
    }
    const kept = new Set(memberNames(next))
    const gone = memberNames(entry).filter(name => !kept.has(name))
    if (gone.length > 0)
      removed.push({ identifier: entry.name, names: [...gone] })
  }
  return removed
}

/** 给模型的「已消失」段：沿用目录的行样式，点名标识符与成员。 */
function removedSection(removed: readonly RemovedCatalogEntry[]): string {
  const rows = removed.map(entry => `  <tool identifier="${entry.identifier}"${entry.names.length > 0 ? ` names="${entry.names.join(',')}"` : ''}/>`)
  return `<removed_tools description="These entries or members are no longer in the tool catalog; their plugin may have been uninstalled or the group rewritten. Ignore any earlier mention of them.">\n${rows.join('\n')}\n</removed_tools>`
}
