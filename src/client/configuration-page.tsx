import type { ReactElement } from 'react'
import type { ActivationCatalog, ActivationCatalogEntry } from '../types'
import type { ConfigurationDraft, ConfigurationOp, ConfigurationScope, PassiveReleaseDraft, ToolActivatorConfigurationProps, ToolGroupDraft, ToolGroupShape } from './types'
import type { SerialWriteQueue, WriteField } from './write-queue'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACTIVATOR_TOOL_NAME, DEACTIVATOR_TOOL_NAME, GROUPING_TOOL_NAME } from '../constants'
import { Collapsible } from './collapsible'
import { CLASSES, GROUPS_WRITE_DELAY_MS } from './constants'
import { groupsSavable, missingMembers } from './groups'
import { GroupsEditor } from './groups-editor'
import { countProblem, passiveReleaseValue, readPassiveReleaseDraft } from './passive-release'
import { ToolActivatorButton, ToolActivatorInput, ToolActivatorSwitch, ToolActivatorTag, ToolActivatorTooltip } from './primitives'
import { createSerialWriteQueue } from './write-queue'

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

/** Stable identity of the host's groups: a change means somebody else wrote the document. */
function groupsSignature(scope: ConfigurationScope): string {
  return JSON.stringify(readGroups(scope) ?? [])
}

/** Groups are copied out of the draft before they reach the Host or a render. */
function cloneGroup(group: ToolGroupShape): ToolGroupDraft {
  return {
    identifier: group.identifier,
    name: group.name,
    description: group.description,
    tools: [...group.tools],
    sections: [...group.sections],
  }
}

/** The draft the page edits, seeded from the Host document it belongs to. */
function readDraft(scope: ConfigurationScope): ConfigurationDraft {
  return {
    basicTools: readList(scope, 'basicTools') ?? [],
    requireApproval: readFlag(scope, 'requireApproval'),
    autoGroupMcp: readFlag(scope, 'autoGroupMcp'),
    passiveRelease: readPassiveReleaseDraft(scope.getSnapshot().value?.passiveRelease),
    groups: readGroups(scope),
  }
}

/** The ops for the drained fields, built from the newest draft at send time. */
function draftOps(draft: ConfigurationDraft, fields: readonly WriteField[]): ConfigurationOp[] {
  const ops: ConfigurationOp[] = []
  for (const field of fields) {
    if (field === 'basicTools') {
      ops.push({ op: 'set', path: ['basicTools'], value: [...draft.basicTools] })
      continue
    }
    if (field === 'requireApproval' && draft.requireApproval !== undefined) {
      ops.push({ op: 'set', path: ['requireApproval'], value: draft.requireApproval })
      continue
    }
    if (field === 'autoGroupMcp' && draft.autoGroupMcp !== undefined) {
      ops.push({ op: 'set', path: ['autoGroupMcp'], value: draft.autoGroupMcp })
      continue
    }
    // An unsavable passive release draft stays local, exactly like a group
    // draft: writing it would only bounce off the Host schema.
    if (field === 'passiveRelease') {
      const value = passiveReleaseValue(draft.passiveRelease)
      if (value !== undefined)
        ops.push({ op: 'set', path: ['passiveRelease'], value })
      continue
    }
    // An unsavable group draft stays local: writing it would only bounce off
    // the Host schema and roll the whole page back to the saved document.
    if (field === 'groups' && draft.groups !== undefined && groupsSavable(draft.groups))
      ops.push({ op: 'set', path: ['groups'], value: draft.groups.map(cloneGroup) })
  }
  return ops
}

function isDefaultLoaded(entry: ActivationCatalogEntry, basicTools: readonly string[]): boolean {
  return entry.tools.length > 0 && entry.tools.every(tool => basicTools.includes(tool))
}

/** Factory defaults are labelled and sorted first, but remain configurable. */
function isBaseTool(entry: ActivationCatalogEntry, baseTools: readonly string[]): boolean {
  return baseTools.length > 0 && entry.tools.length > 0 && entry.tools.every(tool => baseTools.includes(tool))
}

/** A read-only or unavailable document accepts no writes, so the controls lock. */
function isReadOnly(scope: ConfigurationScope): boolean {
  const snapshot = scope.getSnapshot()
  return snapshot.status !== 'ready' || !snapshot.writable
}

export function ToolActivatorConfiguration({ view, configScope, loadToolCatalog }: ToolActivatorConfigurationProps): ReactElement | null {
  const [draft, setDraft] = useState<ConfigurationDraft>(() => readDraft(configScope))
  const [catalog, setCatalog] = useState<ActivationCatalog | undefined>(undefined)
  const [failure, setFailure] = useState('')
  const [readOnly, setReadOnly] = useState(() => isReadOnly(configScope))
  // Folding is a view preference for this visit: both lists start folded and
  // nothing about it reaches the configuration draft.
  const [openLists, setOpenLists] = useState({ active: false, pending: false })
  // The draft leads the Host document between a click and the echo of its own
  // write, so the handlers read it through a ref: two clicks in the same tick
  // both see the first one.
  const draftRef = useRef(draft)
  const aliveRef = useRef(true)
  const groupsTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingGroupsRef = useRef<ToolGroupDraft[] | undefined>(undefined)
  // The groups this page last adopted from the host. A different signature on the
  // next notification means the grouping was changed behind the page — by the
  // model through the grouping tool, or by another window — and the catalog then
  // shows entries the document no longer has.
  const adoptedGroupsRef = useRef(groupsSignature(configScope))

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const updateDraft = useCallback((change: (prev: ConfigurationDraft) => ConfigurationDraft): void => {
    const next = change(draftRef.current)
    draftRef.current = next
    setDraft(next)
  }, [])

  /** Drop every local edit and take the document the Host actually holds. */
  const adoptHost = useCallback((): void => {
    const next = readDraft(configScope)
    adoptedGroupsRef.current = groupsSignature(configScope)
    draftRef.current = next
    setDraft(next)
  }, [configScope])

  /**
   * Re-read the catalog after a group write: the two tool lists show one row
   * per catalog entry, and a saved group is a new entry the Host only knows
   * about once the write landed.
   */
  const refreshCatalog = useCallback(async (): Promise<void> => {
    try {
      const next = await loadToolCatalog()
      if (aliveRef.current)
        setCatalog(next)
    }
    catch (problem) {
      if (aliveRef.current)
        setFailure(problem instanceof Error ? problem.message : String(problem))
    }
  }, [loadToolCatalog])

  const send = useCallback(async (ops: readonly ConfigurationOp[]): Promise<boolean> => {
    if (isReadOnly(configScope)) {
      if (aliveRef.current)
        setFailure('当前配置不可写，无法保存。')
      return false
    }
    if (aliveRef.current)
      setFailure('')
    // No expected revision: the platform form serializes its own writes and
    // tracks the pending revision, while a revision captured when the change
    // was scheduled is stale by construction and gets the write rejected.
    const accepted = await configScope.mutate([...ops])
    if (!accepted && aliveRef.current)
      setFailure('宿主拒绝了本次修改：配置未通过校验，或与其他修改冲突。')
    // Only the entry set moves with groups; basicTools and the two switches are
    // read straight off the draft, so they need no round trip.
    if (accepted && ops.some(op => op.path[0] === 'groups')) {
      // The write this page just made is not an external change: record the
      // document it produced so the next notification does not refresh twice.
      adoptedGroupsRef.current = groupsSignature(configScope)
      await refreshCatalog()
    }
    return accepted
  }, [configScope, refreshCatalog])

  const queue = useMemo<SerialWriteQueue>(() => createSerialWriteQueue({
    opsFor: fields => draftOps(draftRef.current, fields),
    send,
    onRefused: adoptHost,
    onFailed: (problem: unknown) => {
      adoptHost()
      if (aliveRef.current)
        setFailure(problem instanceof Error ? problem.message : String(problem))
    },
  }), [adoptHost, send])

  /** Change the draft, then hand the touched fields to the serial write queue. */
  const commitDraft = useCallback((change: (prev: ConfigurationDraft) => ConfigurationDraft, fields: readonly WriteField[]): void => {
    updateDraft(change)
    queue.mark(fields)
  }, [queue, updateDraft])

  useEffect(() => {
    const sync = (): void => {
      setReadOnly(isReadOnly(configScope))
      // The draft owns the fields until every write lands: adopting the Host's
      // older document mid-flight is what dropped a just-clicked tool.
      if (queue.busy() || pendingGroupsRef.current !== undefined)
        return
      // An external grouping change is a new entry set, so the two tool lists
      // have to be re-read as well; the draft alone would keep showing the old one.
      const external = groupsSignature(configScope) !== adoptedGroupsRef.current
      adoptHost()
      if (external)
        void refreshCatalog()
    }
    return configScope.subscribe(sync)
  }, [adoptHost, configScope, queue, refreshCatalog])

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
          updateDraft(prev => (prev.basicTools.length === 0 ? { ...prev, basicTools: [...next.basicTools] } : prev))
      })
      .catch((problem: unknown) => {
        if (!cancelled)
          setFailure(problem instanceof Error ? problem.message : String(problem))
      })
    return () => {
      cancelled = true
    }
  }, [configScope, loadToolCatalog, updateDraft])

  const groupsForEditor = useMemo<ToolGroupDraft[]>(
    () => draft.groups ?? (catalog?.groups ?? []).map(cloneGroup),
    [catalog, draft.groups],
  )
  const requireApproval = draft.requireApproval ?? catalog?.requireApproval ?? true
  const autoGroupMcp = draft.autoGroupMcp ?? catalog?.autoGroupMcp ?? true
  // The passive release policy is a persistent setting, so the page only ever
  // shows what the document holds: the session's own activations stay out of it.
  const passiveRelease = draft.passiveRelease
  const idleProblem = countProblem(passiveRelease.idleTurns, '空闲轮数必须是大于等于 1 的整数。')
  const capProblem = countProblem(passiveRelease.maxActivatedTools, '激活工具上限必须是大于等于 1 的整数。')
  // The plugin pins its own tools, so no group may ever claim them: the
  // activator loads tools, the deactivator releases them, and the grouping
  // tool rewrites the grouping — bundling any of them would let a group hand
  // out the machinery that defines groups.
  const lockedTools = useMemo(
    () => [
      ...(catalog?.entries ?? []).filter(entry => entry.identifier === ACTIVATOR_TOOL_NAME || entry.identifier === DEACTIVATOR_TOOL_NAME).flatMap(entry => entry.tools),
      GROUPING_TOOL_NAME,
    ],
    [catalog],
  )

  // 缺失判定由宿主端随 catalog 下发，页面只做交集：基础工具里挂着的已卸载
  // 名字在这里点名，分组成员的标注在编辑器里做。
  const uninstalledTools = useMemo(() => catalog?.uninstalledToolNames ?? [], [catalog])
  const missingBasic = useMemo(
    () => missingMembers(draft.basicTools, uninstalledTools),
    [draft.basicTools, uninstalledTools],
  )
  const removeMissingBasic = useCallback((): void => {
    commitDraft(prev => ({ ...prev, basicTools: prev.basicTools.filter(tool => !missingBasic.includes(tool)) }), ['basicTools'])
  }, [commitDraft, missingBasic])

  const partition = useMemo(() => {
    const entries = catalog?.entries ?? []
    const baseTools = catalog?.baseTools ?? []
    const active: ActivationCatalogEntry[] = []
    const pending: ActivationCatalogEntry[] = []
    for (const entry of entries)
      (entry.identifier === ACTIVATOR_TOOL_NAME || entry.identifier === DEACTIVATOR_TOOL_NAME || isDefaultLoaded(entry, draft.basicTools) ? active : pending).push(entry)
    // The plugin's own base tools head their section; everything the user added
    // after them, each group alphabetical.
    const byBaseThenName = (left: ActivationCatalogEntry, right: ActivationCatalogEntry): number => {
      const rank = Number(isBaseTool(right, baseTools)) - Number(isBaseTool(left, baseTools))
      return rank !== 0 ? rank : left.name.localeCompare(right.name)
    }
    return { active: active.sort(byBaseThenName), pending: pending.sort(byBaseThenName) }
  }, [catalog, draft.basicTools])

  const toggle = useCallback((entry: ActivationCatalogEntry, next: boolean): void => {
    commitDraft((prev) => {
      const names = new Set(prev.basicTools)
      for (const tool of entry.tools) {
        if (next)
          names.add(tool)
        else
          names.delete(tool)
      }
      return { ...prev, basicTools: [...names] }
    }, ['basicTools'])
  }, [commitDraft])

  const setFlag = useCallback((field: 'requireApproval' | 'autoGroupMcp', next: boolean): void => {
    commitDraft(prev => ({ ...prev, [field]: next }), [field])
  }, [commitDraft])

  /**
   * The passive release counts are the Host's own rule: a count it would refuse
   * stays a local draft, so the page can say why instead of bouncing off the
   * schema and rolling the whole document back.
   */
  const setPassiveRelease = useCallback((change: (prev: PassiveReleaseDraft) => PassiveReleaseDraft): void => {
    commitDraft(prev => ({ ...prev, passiveRelease: change(prev.passiveRelease) }), ['passiveRelease'])
  }, [commitDraft])

  /**
   * The group draft stays local until it is savable, and a savable draft commits
   * on a short debounce: writing per keystroke would round-trip the Host on
   * every character, re-render the field, and drop the caret.
   */
  const applyGroups = useCallback((next: ToolGroupDraft[]): void => {
    updateDraft(prev => ({ ...prev, groups: next }))
    // Any hint belongs to the edit before this one; a new edit replaces it.
    setFailure('')
    if (groupsTimerRef.current !== undefined) {
      clearTimeout(groupsTimerRef.current)
      groupsTimerRef.current = undefined
    }
    pendingGroupsRef.current = undefined
    if (!groupsSavable(next))
      return
    pendingGroupsRef.current = next
    groupsTimerRef.current = setTimeout(() => {
      groupsTimerRef.current = undefined
      pendingGroupsRef.current = undefined
      queue.mark(['groups'])
    }, GROUPS_WRITE_DELAY_MS)
  }, [queue, updateDraft])

  /** Leaving the page must not drop an edit still waiting for its debounce. */
  const flushGroups = useCallback((): void => {
    const pending = pendingGroupsRef.current
    pendingGroupsRef.current = undefined
    if (groupsTimerRef.current !== undefined) {
      clearTimeout(groupsTimerRef.current)
      groupsTimerRef.current = undefined
    }
    if (pending !== undefined && groupsSavable(pending))
      queue.mark(['groups'])
  }, [queue])
  useEffect(() => flushGroups, [flushGroups])

  if (view === 'summary')
    return <p className={CLASSES.description}>默认只提供基础工具，其余工具由模型按需加载。</p>

  function renderRows(entries: readonly ActivationCatalogEntry[]): ReactElement {
    const baseTools = catalog?.baseTools ?? []
    return (
      <ul className={CLASSES.list}>
        {entries.map((entry) => {
          const locked = entry.identifier === ACTIVATOR_TOOL_NAME || entry.identifier === DEACTIVATOR_TOOL_NAME
          return (
            <li className={CLASSES.row} key={entry.identifier}>
              <span className={CLASSES.rowText}>
                <span className={CLASSES.rowName}>
                  {entry.name}
                  {isBaseTool(entry, baseTools) ? <ToolActivatorTag tone="neutral">基础工具</ToolActivatorTag> : null}
                </span>
                <span className={CLASSES.rowMeta} title={entry.description || entry.tools.join('、')}>{entry.description || entry.tools.join('、')}</span>
              </span>
              <ToolActivatorSwitch
                checked={locked || isDefaultLoaded(entry, draft.basicTools)}
                disabled={readOnly || locked}
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
                    description="非完全权限时，激活工具前先请求你的确认；没有可用的审批服务时直接拒绝激活。完全权限时无需确认。"
                    disabled={readOnly}
                    label="激活前确认"
                    onChange={next => void setFlag('requireApproval', next)}
                  />
                  <SettingRow
                    checked={autoGroupMcp}
                    description="把同一 MCP 服务的工具（mcp__server__tool）聚成一个条目，模型一次激活整个服务；关闭后每个工具各自激活。"
                    disabled={readOnly}
                    label="按 MCP 服务分组"
                    onChange={next => void setFlag('autoGroupMcp', next)}
                  />
                </ul>
              </section>
              <Collapsible
                label={`默认激活工具（${partition.active.length} 个）`}
                onToggle={next => setOpenLists(prev => ({ ...prev, active: next }))}
                open={openLists.active}
              >
                {partition.active.length === 0
                  ? <p className={CLASSES.help}>当前没有默认激活的工具。</p>
                  : renderRows(partition.active)}
                {missingBasic.length > 0
                  ? (
                      <>
                        {missingBasic.map(tool => (
                          <div className={CLASSES.row} key={tool}>
                            <span className={CLASSES.rowText}>
                              <span className={`${CLASSES.rowName} ${CLASSES.choiceMissing}`}>{tool}</span>
                              <span className={CLASSES.missingNote}>已卸载（所属插件可能已被移除；按会话注册的工具在会话运行时恢复）</span>
                            </span>
                          </div>
                        ))}
                        <div className={CLASSES.toolbar}>
                          <span className={CLASSES.missingNote}>{`基础工具里已卸载 ${missingBasic.length} 个：${missingBasic.join('、')}`}</span>
                          <ToolActivatorButton disabled={readOnly} onClick={removeMissingBasic} size="sm" variant="outline">移除已卸载的基础工具</ToolActivatorButton>
                        </div>
                      </>
                    )
                  : null}
              </Collapsible>
              <Collapsible
                label={`已安装但需先激活（${partition.pending.length} 个）`}
                onToggle={next => setOpenLists(prev => ({ ...prev, pending: next }))}
                open={openLists.pending}
              >
                {partition.pending.length === 0
                  ? <p className={CLASSES.help}>全部工具都已默认激活。</p>
                  : renderRows(partition.pending)}
                <p className={CLASSES.help}>按会话注册的工具（例如 git-bash 的 bash）要先有会话在跑才会出现在这里。</p>
              </Collapsible>
              <section className={CLASSES.section}>
                <h4 className={CLASSES.sectionTitle}>工具分组</h4>
                <p className={CLASSES.help}>一组工具共用一个标识符，模型激活该标识符即可一次拿到整组；留空则每个工具各自成为一个条目。</p>
                <GroupsEditor
                  disabled={readOnly}
                  basicTools={draft.basicTools}
                  lockedTools={lockedTools}
                  groups={groupsForEditor}
                  onBlocked={(tool: string) => setFailure(`工具 ${tool} 已属于默认激活或其他分组，不能再加入这一组。`)}
                  onChange={applyGroups}
                  toolNames={(catalog.entries ?? []).flatMap(entry => entry.tools)}
                  uninstalledTools={uninstalledTools}
                />
              </section>
              <section className={CLASSES.section}>
                <h4 className={CLASSES.sectionTitle}>会话工具释放</h4>
                <p className={CLASSES.help}>长会话里临时激活的工具会一直占着上下文；开启后，空闲太久或超过上限的已激活工具会被本会话收回，需要时再激活即可。</p>
                <ul className={CLASSES.list}>
                  <SettingRow
                    checked={passiveRelease.enabled}
                    description="开启后，空闲或超过上限的已激活工具会被本会话自动收回；关闭则保留会话里激活的一切，模型仍可主动释放。"
                    disabled={readOnly}
                    label="启用被动释放"
                    onChange={next => void setPassiveRelease(prev => ({ ...prev, enabled: next }))}
                  />
                </ul>
                <label className={CLASSES.field}>
                  <span className={CLASSES.fieldLabel}>空闲轮数</span>
                  <ToolActivatorInput
                    className={CLASSES.countInput}
                    disabled={readOnly || !passiveRelease.enabled}
                    onValueChange={value => setPassiveRelease(prev => ({ ...prev, idleTurns: value }))}
                    value={passiveRelease.idleTurns}
                  />
                </label>
                {idleProblem === '' ? null : <p className={CLASSES.error}>{idleProblem}</p>}
                <label className={CLASSES.field}>
                  <span className={CLASSES.fieldLabel}>激活工具上限</span>
                  <ToolActivatorInput
                    className={CLASSES.countInput}
                    disabled={readOnly || !passiveRelease.enabled}
                    onValueChange={value => setPassiveRelease(prev => ({ ...prev, maxActivatedTools: value }))}
                    value={passiveRelease.maxActivatedTools}
                  />
                </label>
                {capProblem === '' ? null : <p className={CLASSES.error}>{capProblem}</p>}
              </section>
            </>
          )}
    </section>
  )
}
