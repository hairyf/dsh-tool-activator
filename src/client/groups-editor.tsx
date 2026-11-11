import type { ReactElement } from 'react'
import type { GroupsEditorProps, ToolGroupDraft } from './types'
import { useState } from 'react'
import { Collapsible } from './collapsible'
import { CLASSES, GROUP_IDENTIFIER_PATTERN } from './constants'
import { groupChoices, missingMembers, toolClaimable } from './groups'
import { ToolActivatorButton, ToolActivatorCheckbox, ToolActivatorInput } from './primitives'

function emptyGroup(): ToolGroupDraft {
  return { identifier: '', name: '', description: '', tools: [], sections: [] }
}

/**
 * The `groups` configuration as a structured editor: a group is an identifier
 * plus the real tools it bundles, so tools are picked from the live catalog
 * instead of being typed by hand.
 */
export function GroupsEditor({ basicTools, disabled, groups, lockedTools, onBlocked, toolNames, uninstalledTools, onChange }: GroupsEditorProps): ReactElement {
  // Only the later card of a repeated identifier is flagged: the first one is
  // the definition the duplicate collides with.
  const duplicates = new Set<number>()
  const seen = new Set<string>()
  groups.forEach((group, index) => {
    if (group.identifier === '')
      return
    if (seen.has(group.identifier))
      duplicates.add(index)
    seen.add(group.identifier)
  })

  const replace = (index: number, next: ToolGroupDraft): void => {
    onChange(groups.map((group, at) => (at === index ? next : { ...group })))
  }

  // Folding and filtering are view state for this visit: neither reaches the
  // draft and neither is persisted.
  const [openCards, setOpenCards] = useState<ReadonlySet<number>>(new Set())
  const [filters, setFilters] = useState<Readonly<Record<number, string>>>({})

  const setOpen = (index: number, next: boolean): void => {
    setOpenCards((prev) => {
      const updated = new Set(prev)
      if (next)
        updated.add(index)
      else
        updated.delete(index)
      return updated
    })
  }

  const remove = (index: number): void => {
    // The cards renumber themselves, so the view state starts over.
    setOpenCards(new Set())
    setFilters({})
    onChange(groups.filter((_group, at) => at !== index).map(item => ({ ...item })))
  }

  return (
    <div className={CLASSES.groups}>
      {groups.map((group, index) => {
        // A tool belongs to one place: the card lists its own members plus the
        // tools no other owner holds, so two cards never offer the same tool.
        const choices = groupChoices(toolNames, basicTools, groups, index, lockedTools)
        const position = index + 1
        const invalid = group.identifier === '' || !GROUP_IDENTIFIER_PATTERN.test(group.identifier)
        const duplicate = !invalid && duplicates.has(index)
        const filter = filters[index] ?? ''
        const missing = missingMembers(group.tools, uninstalledTools ?? [])
        const missingSet = new Set(missing)
        const visible = choices.filter(tool => tool.toLowerCase().includes(filter.toLowerCase()))
        return (
          <Collapsible
            actions={(
              <ToolActivatorButton
                disabled={disabled === true}
                onClick={() => remove(index)}
                size="sm"
                variant="ghost"
              >
                {`删除第 ${position} 组`}
              </ToolActivatorButton>
            )}
            // eslint-disable-next-line react/no-array-index-key -- a draft group has no identity until the host saves it
            key={`group-${index}`}
            label={group.identifier === '' ? `未命名分组 ${position}` : group.identifier}
            onToggle={next => setOpen(index, next)}
            open={openCards.has(index)}
          >
            <div className={CLASSES.groupBody}>
              <label className={CLASSES.field}>
                <span className={CLASSES.fieldLabel}>标识符</span>
                <ToolActivatorInput
                  disabled={disabled}
                  onValueChange={identifier => replace(index, { ...group, identifier })}
                  placeholder="files"
                  value={group.identifier}
                />
              </label>
              <label className={CLASSES.field}>
                <span className={CLASSES.fieldLabel}>名称</span>
                <ToolActivatorInput
                  disabled={disabled}
                  onValueChange={name => replace(index, { ...group, name })}
                  placeholder="Files"
                  value={group.name}
                />
              </label>
              <label className={`${CLASSES.field} ${CLASSES.fieldWide}`}>
                <span className={CLASSES.fieldLabel}>说明</span>
                <ToolActivatorInput
                  disabled={disabled}
                  onValueChange={description => replace(index, { ...group, description })}
                  placeholder="File utilities"
                  value={group.description}
                />
              </label>
              <div className={`${CLASSES.field} ${CLASSES.fieldWide}`}>
                <span className={CLASSES.fieldLabel}>工具</span>
                <div className={CLASSES.toolbar}>
                  <ToolActivatorInput
                    className={CLASSES.groupFilter}
                    disabled={disabled}
                    onValueChange={value => setFilters(prev => ({ ...prev, [index]: value }))}
                    placeholder="过滤工具"
                    value={filter}
                  />
                  <ToolActivatorButton
                    disabled={disabled === true || visible.length === 0}
                    onClick={() => replace(index, { ...group, tools: [...new Set([...group.tools, ...visible])] })}
                    size="sm"
                    variant="outline"
                  >
                    {filter === '' ? '全选可选工具' : '全选过滤结果'}
                  </ToolActivatorButton>
                </div>
                <div className={CLASSES.choices}>
                  {visible.map(tool => (
                    <ToolActivatorCheckbox
                      checked={group.tools.includes(tool)}
                      className={missingSet.has(tool) ? `${CLASSES.choice} ${CLASSES.choiceMissing}` : CLASSES.choice}
                      disabled={disabled}
                      key={tool}
                      label={tool}
                      onChange={(checked) => {
                        // A tool another card claimed since this one rendered is
                        // never added here; the page says why instead of letting
                        // the Host refuse the write.
                        if (checked && !toolClaimable(tool, basicTools, groups, index, lockedTools)) {
                          onBlocked?.(tool)
                          return
                        }
                        replace(index, {
                          ...group,
                          tools: checked ? [...group.tools, tool] : group.tools.filter(name => name !== tool),
                        })
                      }}
                    />
                  ))}
                </div>
                {missing.length > 0
                  ? (
                      <div className={CLASSES.toolbar}>
                        <span className={CLASSES.missingNote}>{`已卸载 ${missing.length} 个：${missing.join('、')}（所属插件可能已被移除）`}</span>
                        <ToolActivatorButton
                          disabled={disabled === true}
                          onClick={() => {
                            const kept = group.tools.filter(tool => !missingSet.has(tool))
                            replace(index, { ...group, tools: kept })
                            // 整组都是已卸载成员时，移除后是空分组：宿主不会保存它，
                            // 当场说明，而不是让用户以为清掉了、刷新后又回来。
                            if (kept.length === 0)
                              onBlocked?.(`分组 ${group.identifier || `第 ${position} 组`} 的成员已全部移除；空分组不会被保存，请删除该分组或补充其他工具。`)
                          }}
                          size="sm"
                          variant="outline"
                        >
                          移除已卸载成员
                        </ToolActivatorButton>
                      </div>
                    )
                  : null}
              </div>
              <div className={`${CLASSES.field} ${CLASSES.fieldWide}`}>
                <span className={CLASSES.fieldLabel}>说明节</span>
                {group.sections.map((section, at) => (
                  // eslint-disable-next-line react/no-array-index-key -- a draft section has no identity until the host saves it
                  <div className={CLASSES.toolbar} key={`section-${at}`}>
                    <ToolActivatorInput
                      disabled={disabled}
                      onValueChange={value => replace(index, { ...group, sections: group.sections.map((item, offset) => (offset === at ? value : item)) })}
                      placeholder="plugin:files"
                      value={section}
                    />
                    <ToolActivatorButton
                      disabled={disabled === true}
                      onClick={() => replace(index, { ...group, sections: group.sections.filter((_item, offset) => offset !== at) })}
                      size="sm"
                      variant="ghost"
                    >
                      {`删除第 ${position} 组第 ${at + 1} 个说明节`}
                    </ToolActivatorButton>
                  </div>
                ))}
                <ToolActivatorButton
                  disabled={disabled === true}
                  onClick={() => replace(index, { ...group, sections: [...group.sections, ''] })}
                  size="sm"
                  variant="outline"
                >
                  {`为第 ${position} 组添加说明节`}
                </ToolActivatorButton>
              </div>
              {invalid ? <p className={CLASSES.error}>标识符只能包含字母、数字、下划线、点和连字符。</p> : null}
              {duplicate ? <p className={CLASSES.error}>{`标识符 ${group.identifier} 重复，宿主会拒绝保存。`}</p> : null}
            </div>
          </Collapsible>
        )
      })}
      {groups.length === 0 ? <p className={CLASSES.help}>还没有分组；不分组时每个工具各自作为一个条目。</p> : null}
      <div className={CLASSES.toolbar}>
        <ToolActivatorButton
          disabled={disabled === true}
          onClick={() => {
            // A brand-new card is the one thing worth opening unasked.
            setOpen(groups.length, true)
            onChange([...groups.map(item => ({ ...item })), emptyGroup()])
          }}
          size="sm"
          variant="outline"
        >
          添加分组
        </ToolActivatorButton>
      </div>
    </div>
  )
}
