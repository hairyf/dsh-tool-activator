import type { Context } from '@deepseek-ai/cordis'
import type { ToolGroup } from './shared'

/**
 * The narrow slice of the host settings service this plugin uses. The installed dsh
 * packages predate the service's type declarations, so the shape is declared here
 * and resolved through one guarded cast instead of a module augmentation.
 */
export interface SettingsServiceLike {
  describe: (options?: { redactSecrets?: boolean }) => Array<{ ns: string, revision: number }>
  mutate: (ns: string, ops: ReadonlyArray<{ op: 'set', path: string[], value: unknown }>, expectedRevision?: number) => Promise<void>
}

/**
 * The part of the loader entry this plugin reads. The installed dsh packages do
 * not carry the loader's types, so the namespace is read through one guarded
 * assertion instead of a module augmentation that would collide with the host
 * the day it declares the entry itself.
 */
interface LoaderEntryLike {
  entry?: { options?: { id?: string } }
}

/** The settings service of this host, when the host provides one. */
export function settingsServiceOf(ctx: Context): SettingsServiceLike | undefined {
  const service = ctx.get('settings') as SettingsServiceLike | undefined
  if (!service || typeof service.describe !== 'function' || typeof service.mutate !== 'function')
    return undefined
  return service
}

/**
 * The namespace this plugin writes under: the id of its own loader entry, which
 * is what the settings service knows the entry as.
 */
export function settingsNamespaceOf(ctx: Context): string | undefined {
  const fiber = ctx.fiber as unknown as LoaderEntryLike | undefined
  const id = fiber?.entry?.options?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Write the groups into this plugin's own settings entry.
 *
 * The write is conditional: the entry's revision is read first and handed to the
 * mutation, so a document that changed in between is refused instead of being
 * overwritten. One refusal is retried with a fresh revision — the other writer
 * has just finished, and its result is the base of this write — but a second
 * refusal is that writer's answer and is passed on to the caller.
 */
export async function writeGroups(
  service: SettingsServiceLike,
  ns: string,
  groups: readonly ToolGroup[],
  signal: AbortSignal,
  basicTools?: readonly string[],
): Promise<void> {
  signal.throwIfAborted()
  // The always-loaded set is written in the same mutation as the groups: a
  // document that carries one without the other would be read back as a
  // half-applied edit.
  const ops: ReadonlyArray<{ op: 'set', path: string[], value: unknown }> = basicTools === undefined
    ? [{ op: 'set', path: ['groups'], value: groups }]
    : [
        { op: 'set', path: ['groups'], value: groups },
        { op: 'set', path: ['basicTools'], value: basicTools },
      ]
  try {
    await service.mutate(ns, ops, revisionOf(service, ns))
  }
  catch (error) {
    if (!isConflict(error))
      throw error
    signal.throwIfAborted()
    await service.mutate(ns, ops, revisionOf(service, ns))
  }
}

/** The current revision of one settings entry, read from the host. */
function revisionOf(service: SettingsServiceLike, ns: string): number {
  const row = service.describe({ redactSecrets: true }).find(entry => entry.ns === ns)
  if (!row)
    throw new Error(`The settings entry "${ns}" is not a configurable plugin entry of this host, so the tool groups were not written.`)
  return row.revision
}

/** Whether the host refused the write because the document moved on. */
function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
}
