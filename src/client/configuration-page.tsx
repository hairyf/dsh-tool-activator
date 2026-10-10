import type { FormEvent, ReactElement } from 'react'
import type { ConfigurationEditorState, ToolActivatorConfigurationProps, ToolPolicyDraft } from './types'
import { useEffect, useId, useRef, useState } from 'react'
import { MINIMUM_CORE_VERSION } from '../shared'
import { canWriteConfiguration, createPolicyDraft, policyMutationOps, validatePolicyDraft } from './configuration'
import { CLASSES } from './constants'
import { ToolActivatorIcon } from './icons'

export function ToolActivatorConfiguration({ view, form }: ToolActivatorConfigurationProps): ReactElement {
  const fieldId = useId()
  const aliveRef = useRef(false)
  const requestSerialRef = useRef(0)
  const currentFormRef = useRef(form)
  currentFormRef.current = form
  const writable = canWriteConfiguration(form)
  const mutate = form?.mutate
  const snapshotValue = form?.state.value
  const snapshotRevision = form?.state.revision
  const [editor, setEditor] = useState<ConfigurationEditorState>(() => ({
    mutate,
    writable,
    value: snapshotValue,
    revision: snapshotRevision,
    draft: createPolicyDraft(snapshotValue),
    pending: false,
    feedback: undefined,
  }))
  const ownerChanged = editor.mutate !== mutate || editor.writable !== writable
  const snapshotChanged = editor.value !== snapshotValue || editor.revision !== snapshotRevision
  if (ownerChanged || snapshotChanged) {
    if (ownerChanged)
      requestSerialRef.current += 1
    setEditor({
      mutate,
      writable,
      value: snapshotValue,
      revision: snapshotRevision,
      draft: createPolicyDraft(snapshotValue),
      pending: ownerChanged ? false : editor.pending,
      feedback: ownerChanged || !editor.pending ? undefined : editor.feedback,
    })
  }
  const { draft, pending, feedback } = editor
  const fieldsDisabled = !writable || pending

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      requestSerialRef.current += 1
    }
  }, [])

  function update<K extends keyof ToolPolicyDraft>(key: K, value: ToolPolicyDraft[K]): void {
    setEditor(previous => ({ ...previous, draft: { ...previous.draft, [key]: value }, feedback: undefined }))
  }

  function discard(): void {
    setEditor(previous => ({ ...previous, draft: createPolicyDraft(currentFormRef.current?.state.value), feedback: undefined }))
  }

  async function save(): Promise<void> {
    const acceptedForm = currentFormRef.current
    if (!acceptedForm || !canWriteConfiguration(acceptedForm) || pending)
      return
    const result = validatePolicyDraft(draft)
    if (!result.ok) {
      setEditor(previous => ({ ...previous, feedback: { kind: 'error', message: result.message } }))
      return
    }
    const serial = ++requestSerialRef.current
    const acceptedMutate = acceptedForm.mutate
    const revision = acceptedForm.state.revision
    setEditor(previous => ({ ...previous, pending: true, feedback: undefined }))
    function isCurrent(): boolean {
      return aliveRef.current
        && requestSerialRef.current === serial
        && currentFormRef.current?.mutate === acceptedMutate
        && canWriteConfiguration(currentFormRef.current)
    }
    try {
      const applied = await acceptedForm.mutate(policyMutationOps(result.policy), revision)
      if (!isCurrent())
        return
      setEditor(previous => ({
        ...previous,
        feedback: applied
          ? { kind: 'success', message: '配置已保存。新的模型请求会使用最新工具策略。' }
          : { kind: 'error', message: '宿主未接受保存（配置冲突、校验失败或不可写）。请核对最新配置后重试。' },
      }))
    }
    catch (error) {
      if (!isCurrent())
        return
      setEditor(previous => ({
        ...previous,
        feedback: { kind: 'error', message: `保存失败：${error instanceof Error ? error.message : '无法连接宿主。'}` },
      }))
    }
    finally {
      if (isCurrent())
        setEditor(previous => ({ ...previous, pending: false }))
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void save()
  }

  if (view === 'summary') {
    return (
      <p className={CLASSES.description}>
        默认仅提供基础工具；按需发现和激活其他工具。这不是执行权限授权。
      </p>
    )
  }

  return (
    <section className={CLASSES.root} aria-labelledby={`${fieldId}-title`}>
      <header className={CLASSES.header}>
        <ToolActivatorIcon className={CLASSES.icon} aria-hidden="true" />
        <div>
          <h2 id={`${fieldId}-title`} className={CLASSES.title}>按需工具加载</h2>
          <p className={CLASSES.description}>默认仅向模型展示基础工具，按当前会话和工具作用域发现、激活其他工具。</p>
        </div>
      </header>
      <p className={CLASSES.notice}>
        工具展示不等于执行授权。隐藏、排除或激活工具不会绕过 DSH 的审批、沙箱和工具安全检查。
      </p>
      <p className={CLASSES.version}>
        需要 DSH
        {' '}
        {MINIMUM_CORE_VERSION}
        {' '}
        或以上，且须提供官方插件配置表单。不支持的版本应禁用本功能，不会使用私有 API。
      </p>
      {!form || form.state.status === 'unavailable'
        ? <p role="status" className={CLASSES.notice}>此配置表单不可用。请检查宿主版本、插件加载状态及官方配置服务。</p>
        : form.state.status === 'loading'
          ? <p role="status" className={CLASSES.notice}>正在加载宿主配置…</p>
          : !writable
              ? <p role="status" className={CLASSES.notice}>宿主配置只读或尚未同步。仅在 host 模式、配置可写且版本已同步时允许保存。</p>
              : null}
      <form onSubmit={submit} aria-label="工具激活策略" aria-busy={pending}>
        <fieldset className={CLASSES.fields} disabled={fieldsDisabled}>
          <legend>工具策略</legend>
          <label className={CLASSES.checkbox}>
            <input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)} />
            启用按需工具加载
          </label>
          {!draft.enabled && <p className={CLASSES.help}>关闭时不进行工具展示过滤；仍遵守原有执行权限检查。</p>}
          <div className={CLASSES.field}>
            <label htmlFor={`${fieldId}-mode`}>加载模式</label>
            <select id={`${fieldId}-mode`} value={draft.mode} onChange={event => update('mode', event.target.value === 'manual' ? 'manual' : 'automatic')} aria-describedby={`${fieldId}-mode-help`}>
              <option value="automatic">自动：基础工具 + 按需激活</option>
              <option value="manual">手动：仅基础工具</option>
            </select>
            <p id={`${fieldId}-mode-help`} className={CLASSES.help}>
              {draft.mode === 'manual'
                ? '手动模式仅向模型提供基础工具，不允许通过本插件激活其他工具。'
                : '自动模式保留基础工具与发现、激活入口；激活只改变后续工具展示，不授予执行权限。'}
            </p>
          </div>
          <label className={CLASSES.checkbox}>
            <input type="checkbox" checked={draft.requireApproval} onChange={event => update('requireApproval', event.target.checked)} />
            激活前请求用户确认
          </label>
          <p className={CLASSES.help}>默认开启；没有可用审批服务时拒绝激活。关闭此项也不会关闭核心安全审批。</p>
          <label className={CLASSES.checkbox}>
            <input type="checkbox" checked={draft.autoGroupMcp} onChange={event => update('autoGroupMcp', event.target.checked)} />
            自动按 MCP 服务分组
          </label>
          <p className={CLASSES.help}>只根据公开的 mcp__server__tool 工具名聚合，不推测服务器私有元数据。</p>
          <div className={CLASSES.field}>
            <label htmlFor={`${fieldId}-basic`}>基础工具（每行一个名称）</label>
            <textarea id={`${fieldId}-basic`} rows={6} value={draft.basicToolsText} onChange={event => update('basicToolsText', event.target.value)} aria-describedby={`${fieldId}-basic-help`} spellCheck={false} />
            <p id={`${fieldId}-basic-help`} className={CLASSES.help}>填写真实工具名；默认包含 read、glob、grep、skill、ask_user_question、todo_write。</p>
          </div>
          <div className={CLASSES.field}>
            <label htmlFor={`${fieldId}-excluded`}>排除工具（每行一个名称）</label>
            <textarea id={`${fieldId}-excluded`} rows={3} value={draft.excludedToolsText} onChange={event => update('excludedToolsText', event.target.value)} aria-describedby={`${fieldId}-excluded-help`} spellCheck={false} />
            <p id={`${fieldId}-excluded-help`} className={CLASSES.help}>不纳入本插件的发现与激活目录；不是禁止执行名单，也不是安全权限边界。</p>
          </div>
          <details className={CLASSES.advanced}>
            <summary>高级：显式分组与说明节依赖</summary>
            <div className={CLASSES.field}>
              <label htmlFor={`${fieldId}-groups`}>工具分组（JSON 数组）</label>
              <textarea id={`${fieldId}-groups`} rows={8} value={draft.groupsText} onChange={event => update('groupsText', event.target.value)} aria-describedby={`${fieldId}-groups-help`} spellCheck={false} />
              <p id={`${fieldId}-groups-help`} className={CLASSES.help}>每项包含唯一 identifier、至少一个 tools 工具名；可选 name、description、sections。每个工具只能属于一个分组。空名称和描述采用默认说明。</p>
            </div>
            <div className={CLASSES.field}>
              <label htmlFor={`${fieldId}-sections`}>说明节依赖（JSON 对象）</label>
              <textarea id={`${fieldId}-sections`} rows={6} value={draft.sectionToolsText} onChange={event => update('sectionToolsText', event.target.value)} aria-describedby={`${fieldId}-sections-help`} spellCheck={false} />
              <p id={`${fieldId}-sections-help`} className={CLASSES.help}>将公开系统说明节名称映射到真实工具名数组；仅用于与工具一起显示相关说明，不改写核心安全说明。</p>
            </div>
          </details>
        </fieldset>
        {feedback && (
          <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={feedback.kind === 'error' ? CLASSES.error : CLASSES.success}>
            {feedback.message}
          </p>
        )}
        {pending && <p role="status" className={CLASSES.help}>正在保存宿主配置…</p>}
        <div className={CLASSES.actions}>
          <button type="submit" disabled={fieldsDisabled}>{pending ? '保存中…' : '保存配置'}</button>
          <button type="button" disabled={fieldsDisabled} onClick={discard}>放弃未保存更改</button>
        </div>
      </form>
    </section>
  )
}
