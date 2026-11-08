import type { SettingsServiceLike } from './group-writer'
import type { ToolGroup } from './shared'
import { describe, expect, it } from 'vitest'
import { writeGroups } from './group-writer'

interface Mutation {
  ns: string
  ops: ReadonlyArray<{ op: 'set', path: string[], value: unknown }>
  expectedRevision?: number
}

/** The refusal the host answers a stale write with. */
function conflict(): Error & { code: string } {
  const error = new Error('the settings document moved on') as Error & { code: string }
  error.code = 'SETTINGS_CONFLICT'
  return error
}

/** A settings service that answers with the calls it received. */
class FakeSettings implements SettingsServiceLike {
  revision = 7
  /** How many of the next writes are refused as stale. */
  conflicts = 0
  /** How many times the entry was read. */
  reads = 0
  readonly mutations: Mutation[] = []

  constructor(private readonly namespace = 'tool-activator') { }

  describe(): Array<{ ns: string, revision: number }> {
    this.reads += 1
    return [{ ns: this.namespace, revision: this.revision }]
  }

  async mutate(ns: string, ops: ReadonlyArray<{ op: 'set', path: string[], value: unknown }>, expectedRevision?: number): Promise<void> {
    this.mutations.push({ ns, ops, expectedRevision })
    if (this.conflicts > 0) {
      this.conflicts -= 1
      // The other writer finished first, so the document moved on.
      this.revision += 1
      throw conflict()
    }
  }
}

const GROUPS: ToolGroup[] = [
  { identifier: 'files', name: 'Files', description: 'File utilities', tools: ['pwsh'], sections: [] },
]

describe('writeGroups', () => {
  it('writes the groups under the revision it read', async () => {
    const service = new FakeSettings()

    await writeGroups(service, 'tool-activator', GROUPS, new AbortController().signal)

    expect(service.reads).toBe(1)
    expect(service.mutations).toEqual([
      { ns: 'tool-activator', ops: [{ op: 'set', path: ['groups'], value: GROUPS }], expectedRevision: 7 },
    ])
  })

  it('re-reads the revision and writes once more after a stale refusal', async () => {
    const service = new FakeSettings()
    service.conflicts = 1

    await writeGroups(service, 'tool-activator', GROUPS, new AbortController().signal)

    expect(service.reads).toBe(2)
    expect(service.mutations).toHaveLength(2)
    expect(service.mutations[0]?.expectedRevision).toBe(7)
    expect(service.mutations[1]?.expectedRevision).toBe(8)
    expect(service.mutations[1]?.ops).toEqual([{ op: 'set', path: ['groups'], value: GROUPS }])
  })

  it('passes the second stale refusal on instead of writing again', async () => {
    const service = new FakeSettings()
    service.conflicts = 2

    await expect(writeGroups(service, 'tool-activator', GROUPS, new AbortController().signal)).rejects.toThrow('the settings document moved on')

    expect(service.mutations).toHaveLength(2)
  })

  it('passes a refusal that is not a conflict on without a second attempt', async () => {
    const service = new FakeSettings()
    service.mutate = async (): Promise<void> => {
      throw new Error('the entry is not volatile')
    }

    await expect(writeGroups(service, 'tool-activator', GROUPS, new AbortController().signal)).rejects.toThrow('the entry is not volatile')

    expect(service.mutations).toHaveLength(0)
  })

  it('writes nothing when the call was aborted before it started', async () => {
    const service = new FakeSettings()
    const controller = new AbortController()
    controller.abort()

    await expect(writeGroups(service, 'tool-activator', GROUPS, controller.signal)).rejects.toThrow()

    expect(service.reads).toBe(0)
    expect(service.mutations).toEqual([])
  })

  it('refuses to write an entry this host does not know', async () => {
    const service = new FakeSettings('another-entry')

    await expect(writeGroups(service, 'tool-activator', GROUPS, new AbortController().signal)).rejects.toThrow('is not a configurable plugin entry')

    expect(service.mutations).toEqual([])
  })
})
