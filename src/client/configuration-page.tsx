import type { ReactElement } from 'react'
import type { ActivationCatalog, ActivationCatalogEntry } from '../types'
import type { ConfigurationScope, ToolActivatorConfigurationProps } from './types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CLASSES } from './constants'
import { ToolActivatorButton, ToolActivatorSwitch, ToolActivatorTag } from './primitives'

function readBasicTools(scope: ConfigurationScope): string[] {
  const value = scope.getSnapshot().value
  const list = value?.basicTools
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
}

function hasStoredBasicTools(scope: ConfigurationScope): boolean {
  return Array.isArray(scope.getSnapshot().value?.basicTools)
}

function isDefaultLoaded(entry: ActivationCatalogEntry, basicTools: readonly string[]): boolean {
  return entry.tools.length > 0 && entry.tools.every(tool => basicTools.includes(tool))
}

export function ToolActivatorConfiguration({ view, configScope, loadToolCatalog }: ToolActivatorConfigurationProps): ReactElement | null {
  const [basicTools, setBasicTools] = useState<string[]>(() => readBasicTools(configScope))
  const [catalog, setCatalog] = useState<ActivationCatalog | undefined>(undefined)
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    const sync = (): void => setBasicTools(readBasicTools(configScope))
    return configScope.subscribe(sync)
  }, [configScope])

  useEffect(() => {
    let cancelled = false
    loadToolCatalog()
      .then((next) => {
        if (cancelled)
          return
        setCatalog(next)
        // The stored document may carry no basicTools field at all; the host's
        // live policy is then the only source for what is currently default.
        if (hasStoredBasicTools(configScope) === false)
          setBasicTools(next.basicTools)
      })
      .catch((problem: unknown) => {
        if (!cancelled)
          setFailure(problem instanceof Error ? problem.message : String(problem))
      })
    return () => {
      cancelled = true
    }
  }, [configScope, loadToolCatalog])

  const groups = useMemo(() => {
    const entries = catalog?.entries ?? []
    const active: ActivationCatalogEntry[] = []
    const pending: ActivationCatalogEntry[] = []
    for (const entry of entries)
      (isDefaultLoaded(entry, basicTools) ? active : pending).push(entry)
    return { active, pending }
  }, [basicTools, catalog])

  const toggle = useCallback(async (entry: ActivationCatalogEntry, next: boolean): Promise<void> => {
    const snapshot = configScope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable || snapshot.mode !== 'host') {
      setFailure('当前配置不可写，无法保存。')
      return
    }
    const names = new Set(basicTools)
    for (const tool of entry.tools)
      next ? names.add(tool) : names.delete(tool)
    const updated = [...names]
    const previous = basicTools
    setBasicTools(updated)
    setBusy(true)
    setFailure('')
    try {
      const accepted = await configScope.mutate([{ op: 'set', path: ['basicTools'], value: updated }], snapshot.revision)
      if (!accepted && aliveRef.current) {
        setBasicTools(previous)
        setFailure('宿主拒绝了本次修改。')
      }
    }
    catch (problem) {
      if (aliveRef.current) {
        setBasicTools(previous)
        setFailure(problem instanceof Error ? problem.message : String(problem))
      }
    }
    finally {
      if (aliveRef.current)
        setBusy(false)
    }
  }, [basicTools, configScope])

  const reset = useCallback(async (): Promise<void> => {
    const snapshot = configScope.getSnapshot()
    const previous = basicTools
    const defaults = catalog?.baseTools ?? []
    if (defaults.length === 0) {
      setFailure('插件没有可恢复的默认工具集。')
      return
    }
    if (snapshot.status !== 'ready' || !snapshot.writable || snapshot.mode !== 'host') {
      setFailure('当前配置不可写，无法保存。')
      return
    }
    setBasicTools(defaults)
    setBusy(true)
    setFailure('')
    try {
      // Written explicitly rather than cleared: an outer composition layer may
      // pin basicTools, and clearing only the user layer would leave that pin in
      // force and look like the button did nothing.
      const accepted = await configScope.mutate([{ op: 'set', path: ['basicTools'], value: defaults }], snapshot.revision)
      if (!accepted && aliveRef.current) {
        setBasicTools(previous)
        setFailure('宿主拒绝了本次修改。')
      }
    }
    catch (problem) {
      if (aliveRef.current) {
        setBasicTools(previous)
        setFailure(problem instanceof Error ? problem.message : String(problem))
      }
    }
    finally {
      if (aliveRef.current)
        setBusy(false)
    }
  }, [basicTools, catalog, configScope])

  if (view === 'summary')
    return <p className={CLASSES.description}>默认只提供基础工具，其余工具由模型按需加载。</p>

  function renderRows(entries: readonly ActivationCatalogEntry[]): ReactElement {
    const baseTools = catalog?.baseTools ?? []
    return (
      <ul className={CLASSES.list}>
        {entries.map((entry) => {
          const locked = baseTools.length > 0 && entry.tools.length > 0 && entry.tools.every(tool => baseTools.includes(tool))
          return (
            <li className={CLASSES.row} key={entry.identifier}>
              <span className={CLASSES.rowText}>
                <span className={CLASSES.rowName}>
                  {entry.name}
                  {locked ? <ToolActivatorTag tone="neutral">基础工具</ToolActivatorTag> : null}
                </span>
                <span className={CLASSES.rowMeta} title={entry.description || entry.tools.join('、')}>{entry.description || entry.tools.join('、')}</span>
              </span>
              <ToolActivatorSwitch
                checked={isDefaultLoaded(entry, basicTools)}
                disabled={busy || locked}
                label={`默认加载 ${entry.name}`}
                onChange={next => void toggle(entry, next)}
              />
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <section className={CLASSES.root}>
      <header className={CLASSES.header}>
        <h3 className={CLASSES.title}>工具</h3>
        <p className={CLASSES.description}>打开开关即默认加载；关闭后按需加载，由模型用 activate_tools 获取。</p>
      </header>
      {failure === '' ? null : <p className={CLASSES.error} role="alert">{failure}</p>}
      {catalog === undefined
        ? <p className={CLASSES.help} role="status">{failure === '' ? '正在读取工具列表…' : '工具列表不可用。'}</p>
        : (
            <>
              <section className={CLASSES.section}>
                <h4 className={CLASSES.sectionTitle}>{`默认激活工具（${groups.active.length} 个）`}</h4>
                {groups.active.length === 0
                  ? <p className={CLASSES.help}>当前没有默认激活的工具。</p>
                  : renderRows(groups.active)}
              </section>
              <section className={CLASSES.section}>
                <h4 className={CLASSES.sectionTitle}>{`已安装但需先激活（${groups.pending.length} 个）`}</h4>
                {groups.pending.length === 0
                  ? <p className={CLASSES.help}>全部工具都已默认激活。</p>
                  : renderRows(groups.pending)}
              </section>
              <div className={CLASSES.actions}>
                <ToolActivatorButton
                  disabled={busy}
                  onClick={() => void reset()}
                  size="sm"
                  variant="outline"
                >
                  {`恢复默认（${(catalog.baseTools ?? []).length} 个基础工具）`}
                </ToolActivatorButton>
                <span className={CLASSES.help}>清除本机保存的默认集，回到插件自带的清单。</span>
              </div>
            </>
          )}
    </section>
  )
}
