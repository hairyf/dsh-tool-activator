import type { ConfigurationOp } from './types'

/** The config fields this page can dirty; a drain ships them in one write. */
export type WriteField = 'basicTools' | 'requireApproval' | 'autoGroupMcp' | 'groups'

export interface SerialWriteQueueOptions {
  /**
   * Build the ops for the dirty fields, called when a batch is sent rather than
   * when a change arrives: a batch then always carries the newest draft, so a
   * burst of clicks cannot resurrect an older value.
   */
  opsFor: (fields: readonly WriteField[]) => ConfigurationOp[]
  /** Send one atomic batch; resolves whether the Host accepted it. */
  send: (ops: readonly ConfigurationOp[]) => Promise<boolean>
  /** The Host refused the batch, so the draft no longer matches the document. */
  onRefused: () => void
  /** The batch threw instead of answering. */
  onFailed: (problem: unknown) => void
}

export interface SerialWriteQueue {
  /** Dirty the fields and drain; marks made during a flight merge into the next batch. */
  mark: (fields: readonly WriteField[]) => void
  /** Whether a batch is in flight or still dirtied. */
  busy: () => boolean
  /** Resolve once nothing is left to write. */
  idle: () => Promise<void>
}

/**
 * One write path for every control on the page. Batches are serial because the
 * Host document carries a single revision, so two writes in flight race it; and
 * they are coalesced because only the latest draft matters, not every step
 * between it and the saved document.
 */
export function createSerialWriteQueue(options: SerialWriteQueueOptions): SerialWriteQueue {
  const dirty = new Set<WriteField>()
  let running: Promise<void> | undefined

  const drain = async (): Promise<void> => {
    while (dirty.size > 0) {
      const fields = [...dirty]
      dirty.clear()
      const ops = options.opsFor(fields)
      if (ops.length === 0)
        continue
      let accepted: boolean
      try {
        accepted = await options.send(ops)
      }
      catch (problem) {
        dirty.clear()
        options.onFailed(problem)
        return
      }
      if (!accepted) {
        dirty.clear()
        options.onRefused()
        return
      }
    }
  }

  return {
    mark: (fields) => {
      for (const field of fields)
        dirty.add(field)
      if (running !== undefined)
        return
      running = drain().finally(() => {
        running = undefined
      })
    },
    busy: () => running !== undefined || dirty.size > 0,
    idle: () => running ?? Promise.resolve(),
  }
}
