import type { ReactElement } from 'react'
import type { ActivationCatalog, ActivationCatalogEntry } from '../types'
import type { ConfigurationScope, ToolActivatorConfigurationProps } from './types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CLASSES } from './constants'
import { ToolActivatorSwitch } from './primitives'

function readBasicTools(scope: ConfigurationScope): string[] {
  const value = scope.getSnapshot().value
  const list = value?.basicTools
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
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
        if (!cancelled)
          setCatalog(next)
      })
      .catch((problem: unknown) => {
        if (!cancelled)
          setFailure(problem instanceof Error ? problem.message : String(problem))
      })
    return () => {
      cancelled = true
    }
  }, [loadToolCatalog])

  const toggle = useCallback(async (entry: ActivationCatalogEntry, next: boolean): Promise<void> => {
    const snapshot = configScope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable || snapshot.mode !== 'host') {
      setFailure('当前配置不可写，无法保存。')
      return
    }
    const names = new Set(basicTools)
    for (const tool of entry.tools)
      next ? names.add(tool) : names.delete(tool)
    setBusy(true)
    setFailure('')
    try {
      const accepted = await configScope.mutate([{ op: 'set', path: ['basicTools'], value: [...names] }], snapshot.revision)
      if (!accepted && aliveRef.current)
        setFailure('宿主拒绝了本次修改。')
    }
    catch (problem) {
      if (aliveRef.current)
        setFailure(problem instanceof Error ? problem.message : String(problem))
    }
    finally {
      if (aliveRef.current)
        setBusy(false)
    }
  }, [basicTools, configScope])

  if (view === 'summary')
    return <p className={CLASSES.description}>默认只提供基础工具，其余工具由模型按需加载。</p>

  const ready = catalog !== undefined
  return (
    <section className={CLASSES.root}>
      <header className={CLASSES.header}>
        <h3 className={CLASSES.title}>工具</h3>
        <p className={CLASSES.description}>打开开关即默认加载；关闭后按需加载，由模型用 activate_tools 获取。</p>
      </header>
      {failure === '' ? null : <p className={CLASSES.error} role="alert">{failure}</p>}
      {ready
        ? (
            <ul className={CLASSES.list}>
              {catalog.entries.map((entry) => {
                const on = entry.tools.length > 0 && entry.tools.every(tool => basicTools.includes(tool))
                return (
                  <li className={CLASSES.row} key={entry.identifier}>
                    <span className={CLASSES.rowText}>
                      <span className={CLASSES.rowName}>{entry.name}</span>
                      <span className={CLASSES.rowMeta}>{entry.tools.join('、')}</span>
                    </span>
                    <ToolActivatorSwitch
                      checked={on}
                      disabled={busy}
                      label={`默认加载 ${entry.name}`}
                      onChange={next => void toggle(entry, next)}
                    />
                  </li>
                )
              })}
            </ul>
          )
        : <p className={CLASSES.help} role="status">{failure === '' ? '正在读取工具列表…' : '工具列表不可用。'}</p>}
      <p className={CLASSES.help}>
        已默认加载
        {' '}
        {basicTools.length}
        {' '}
        个工具；其余
        {' '}
        {ready ? catalog.entries.reduce((total, entry) => total + entry.tools.filter(tool => !basicTools.includes(tool)).length, 0) : 0}
        {' '}
        个按需加载。
      </p>
    </section>
  )
}
