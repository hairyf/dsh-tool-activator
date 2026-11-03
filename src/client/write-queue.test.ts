import type { ConfigurationOp } from './types'
import { describe, expect, it, vi } from 'vitest'
import { createSerialWriteQueue } from './write-queue'

/**
 * The queue reads the draft when it sends, so a test changes the draft map
 * between marks to prove a batch carries the newest values, not the ones
 * captured when the change arrived.
 */
function harness(): {
  draft: Map<string, string>
  queue: ReturnType<typeof createSerialWriteQueue>
  sent: ConfigurationOp[][]
  settle: Array<(accepted: boolean) => void>
  onRefused: ReturnType<typeof vi.fn>
  onFailed: ReturnType<typeof vi.fn>
} {
  const draft = new Map<string, string>([['basicTools', 'read'], ['groups', 'files']])
  const sent: ConfigurationOp[][] = []
  const settle: Array<(accepted: boolean) => void> = []
  const onRefused = vi.fn()
  const onFailed = vi.fn()
  const queue = createSerialWriteQueue({
    opsFor: fields => fields.map(field => ({ op: 'set', path: [field], value: draft.get(field) ?? '' })),
    send: (ops) => {
      sent.push([...ops])
      return new Promise<boolean>((resolve) => {
        settle.push(resolve)
      })
    },
    onRefused,
    onFailed,
  })
  return { draft, queue, sent, settle, onRefused, onFailed }
}

describe('serial write queue', () => {
  it('keeps one batch in flight and merges what was dirtied meanwhile', async () => {
    const { draft, queue, sent, settle } = harness()

    queue.mark(['basicTools'])
    expect(sent).toHaveLength(1)

    queue.mark(['groups'])
    queue.mark(['basicTools'])
    expect(sent).toHaveLength(1)

    // The newest draft is what the second batch has to carry.
    draft.set('basicTools', 'read write')
    settle[0]!(true)

    await vi.waitFor(() => expect(sent).toHaveLength(2))
    settle[1]!(true)
    await queue.idle()

    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual([
      { op: 'set', path: ['groups'], value: 'files' },
      { op: 'set', path: ['basicTools'], value: 'read write' },
    ])
    expect(queue.busy()).toBe(false)
  })

  it('stops draining and reports once when the Host refuses a batch', async () => {
    const { queue, sent, settle, onRefused, onFailed } = harness()

    queue.mark(['basicTools'])
    queue.mark(['groups'])
    settle[0]!(false)
    await queue.idle()

    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(queue.busy()).toBe(false)
  })

  it('reports a throwing batch instead of rejecting the drain', async () => {
    const onFailed = vi.fn()
    const queue = createSerialWriteQueue({
      opsFor: () => [{ op: 'set', path: ['basicTools'], value: [] }],
      send: async () => {
        throw new Error('连接已断开。')
      },
      onRefused: vi.fn(),
      onFailed,
    })

    queue.mark(['basicTools'])
    await queue.idle()

    expect(onFailed).toHaveBeenCalledTimes(1)
    expect((onFailed.mock.calls[0]![0] as Error).message).toBe('连接已断开。')
    expect(queue.busy()).toBe(false)
  })

  it('sends nothing when the drained fields produce no ops', async () => {
    const send = vi.fn(async () => true)
    const queue = createSerialWriteQueue({ opsFor: () => [], send, onRefused: vi.fn(), onFailed: vi.fn() })

    queue.mark(['groups'])
    await queue.idle()

    expect(send).not.toHaveBeenCalled()
    expect(queue.busy()).toBe(false)
  })

  it('resolves idle immediately when nothing is queued', async () => {
    const { queue } = harness()

    await expect(queue.idle()).resolves.toBeUndefined()
    expect(queue.busy()).toBe(false)
  })
})
