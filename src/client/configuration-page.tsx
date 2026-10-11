import type { ReactElement } from 'react'
import type { ActivationCatalog, ActivationCatalogEntry } from '../types'
import type { ConfigurationScope, ToolActivatorConfigurationProps, ToolGroupDraft } from './types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CLASSES } from './constants'
import { GroupsEditor } from './groups-editor'
import { ToolActivatorSwitch, ToolActivatorTag, ToolActivatorTooltip } from './primitives'

interface SettingRowProps {
  checked: boolean
  description: string
  disabled: boolean
  label: string
  onChange: (next: boolean) => void
}

/** One labelled switch: the name, its explanation on hover, and the control. */
function SettingRow({ checked, description, disabled, label, onChange }: SettingRowProps): ReactElement {
  return (
    <li className={CLASSES.setting}>
      <span className={CLASSES.rowText}>
        <span className={CLASSES.rowName}>
          {label}
          <ToolActivatorTooltip label={description}>
            <span aria-hidden="true" className={CLASSES.settingIcon}>?</span>
          </ToolActivatorTooltip>
        </span>
        <span className={CLASSES.rowMeta}>{description}</span>
      </span>
      <ToolActivatorSwitch checked={checked} disabled={disabled} label={label} onChange={onChange} />
    </li>
  )
}

function readList(scope: ConfigurationScope, field: string): string[] | undefined {
  const value = scope.getSnapshot().value?.[field]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function readFlag(scope: ConfigurationScope, field: string): boolean | undefined {
  const value = scope.getSnapshot().value?.[field]
  return typeof value === 'boolean' ? value : undefined
}

function readGroups(scope: ConfigurationScope): ToolGroupDraft[] | undefined {
  const value = scope.getSnapshot().value?.groups
  if (!Array.isArray(value))
    return undefined
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object')
      return []
    const group = item as Partial<ToolGroupDraft>
    return [{
      identifier: typeof group.identifier === 'string' ? group.identifier : '',
      name: typeof group.name === 'string' ? group.name : '',
      description: typeof group.description === 'string' ? group.description : '',
      tools: Array.isArray(group.tools) ? group.tools.filter((tool): tool is string => typeof tool === 'string') : [],
      sections: Array.isArray(group.sections) ? group.sections.filter((section): section is string => typeof section === 'string') : [],
    }]
  })
}

function isDefaultLoaded(entry: ActivationCatalogEntry, basicTools: readonly string[]): boolean {
  return entry.tools.length > 0 && entry.tools.every(tool => basicTools.includes(tool))
}

/** The plugin's own base tools stay loaded whether or not the document lists them. */
function isBaseTool(entry: ActivationCatalogEntry, baseTools: readonly string[]): boolean {
  return baseTools.length > 0 && entry.tools.length > 0 && entry.tools.every(tool => baseTools.includes(tool))
}

export function ToolActivatorConfiguration({ view, configScope, loadToolCatalog }: ToolActivatorConfigurationProps): ReactElement | null {
  const [basicTools, setBasicTools] = useState<string[]>(() => readList(configScope, 'basicTools') ?? [])
  const [flags, setFlags] = useState(() => ({
    requireApproval: readFlag(configScope, 'requireApproval'),
    autoGroupMcp: readFlag(configScope, 'autoGroupMcp'),
  }))
  const [groups, setGroups] = useState<ToolGroupDraft[] | undefined>(() => readGroups(configScope))
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
    const sync = (): void => {
      setBasicTools(readList(configScope, 'basicTools') ?? [])
      setFlags({
        requireApproval: readFlag(configScope, 'requireApproval'),
        autoGroupMcp: readFlag(configScope, 'autoGroupMcp'),
      })
      setGroups(readGroups(configScope))
    }
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
        if (readList(configScope, 'basicTools') === undefined)
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

  /** One write path for every control on the page: optimistic, then verified. */
  const write = useCallback(async (field: string, value: unknown, revert: () => void): Promise<boolean> => {
    const snapshot = configScope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable || snapshot.mode !== 'host') {
      setFailure('当前配置不可写，无法保存。')
      return false
    }
    setBusy(true)
    setFailure('')
    try {
      const accepted = await configScope.mutate([{ op: 'set', path: [field], value }], snapshot.revision)
      if (!accepted && aliveRef.current) {
        revert()
        setFailure('宿主拒绝了本次修改。')
      }
      return accepted
    }
    catch (problem) {
      if (aliveRef.current) {
        revert()
        setFailure(problem instanceof Error ? problem.message : String(problem))
      }
      return false
    }
    finally {
      if (aliveRef.current)
        setBusy(false)
    }
  }, [configScope])

  const groupsForEditor = useMemo<ToolGroupDraft[]>(
    () => groups ?? (catalog?.groups ?? []).map(group => ({
      identifier: group.identifier,
      name: group.name,
      description: group.description,
      tools: [...group.tools],
      sections: [...group.sections],
    })),
    [catalog, groups],
  )
  const requireApproval = flags.requireApproval ?? catalog?.requireApproval ?? true
  const autoGroupMcp = flags.autoGroupMcp ?? catalog?.autoGroupMcp ?? true

  const partition = useMemo(() => {
    const entries = catalog?.entries ?? []
    const baseTools = catalog?.baseTools ?? []
    const active: ActivationCatalogEntry[] = []
    const pending: ActivationCatalogEntry[] = []
    for (const entry of entries)
      (isBaseTool(entry, baseTools) || isDefaultLoaded(entry, basicTools) ? active : pending).push(entry)
    // The plugin's own base tools head their section; everything the user added
    // after them, each group alphabetical.
    const byBaseThenName = (left: ActivationCatalogEntry, right: ActivationCatalogEntry): number => {
      const rank = Number(isBaseTool(right, baseTools)) - Number(isBaseTool(left, baseTools))
      return rank !== 0 ? rank : left.name.localeCompare(right.name)
    }
    return { active: active.sort(byBaseThenName), pending: pending.sort(byBaseThenName) }
  }, [basicTools, catalog])

  const toggle = useCallback(async (entry: ActivationCatalogEntry, next: boolean): Promise<void> => {
    const names = new Set(basicTools)
    for (const tool of entry.tools)
      next ? names.add(tool) : names.delete(tool)
    const updated = [...names]
    const previous = basicTools
    setBasicTools(updated)
    await write('basicTools', updated, () => setBasicTools(previous))
  }, [basicTools, write])

  const setFlag = useCallback(async (field: 'requireApproval' | 'autoGroupMcp', next: boolean): Promise<void> => {
    const previous = flags
    setFlags({ ...flags, [field]: next })
    await write(field, next, () => setFlags(previous))
  }, [flags, write])

  const applyGroups = useCallback(async (next: ToolGroupDraft[]): Promise<void> => {
    const previous = groupsForEditor
    setGroups(next)
    await write('groups', next, () => setGroups(previous))
  }, [groupsForEditor, write])

  if (view === 'summary')
    return <p className={CLASSES.description}>默认只提供基础工具，其余工具由模型按需加载。</p>

  function renderRows(entries: readonly ActivationCatalogEntry[]): ReactElement {
    const baseTools = catalog?.baseTools ?? []
    return (
      <ul className={CLASSES.list}>
        {entries.map((entry) => {
          const locked = isBaseTool(entry, baseTools)
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
                checked={locked || isDefaultLoaded(entry, basicTools)}
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
                <h4 className={CLASSES.sectionTitle}>常规</h4>
                <ul className={CLASSES.list}>
                  <SettingRow
                    checked={requireApproval}
                    description="激活工具前先请求你的确认；没有可用的审批服务时直接拒绝激活。"
                    disabled={busy}
                    label="激活前确认"
                    onChange={next => void setFlag('requireApproval', next)}
                  />
                  <SettingRow
                    checked={autoGroupMcp}
                    description="把同一 MCP 服务的工具（mcp__server__tool）聚成一个条目，模型一次激活整个服务；关闭后每个工具各自激活。"
                    disabled={busy}
                    label="按 MCP 服务分组"
                    onChange={next => void setFlag('autoGroupMcp', next)}
                  />
                </ul>
              </section>
              <section className={CLASSES.section}>
                <h4 className={CLASSES.sectionTitle}>{`默认激活工具（${partition.active.length} 个）`}</h4>
                {partition.active.length === 0
                  ? <p className={CLASSES.help}>当前没有默认激活的工具。</p>
                  : renderRows(partition.active)}
              </section>
              <section className={CLASSES.section}>
                <h4 className={CLASSES.sectionTitle}>{`已安装但需先激活（${partition.pending.length} 个）`}</h4>
                {partition.pending.length === 0
                  ? <p className={CLASSES.help}>全部工具都已默认激活。</p>
                  : renderRows(partition.pending)}
              </section>
              <section className={CLASSES.section}>
                <h4 className={CLASSES.sectionTitle}>工具分组</h4>
                <p className={CLASSES.help}>一组工具共用一个标识符，模型激活该标识符即可一次拿到整组；留空则每个工具各自成为一个条目。</p>
                <GroupsEditor
                  disabled={busy}
                  groups={groupsForEditor}
                  onChange={next => void applyGroups(next)}
                  toolNames={(catalog.entries ?? []).flatMap(entry => entry.tools)}
                />
              </section>
            </>
          )}
    </section>
  )
}
