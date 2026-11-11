import type { ReactElement } from 'react'
import type { GroupsEditorProps, ToolGroupDraft } from './types'
import { CLASSES } from './constants'
import { ToolActivatorButton, ToolActivatorCheckbox, ToolActivatorInput } from './primitives'

const IDENTIFIER_PATTERN = /^[\w.-]+$/u

function emptyGroup(): ToolGroupDraft {
  return { identifier: '', name: '', description: '', tools: [], sections: [] }
}

/**
 * The `groups` configuration as a structured editor: a group is an identifier
 * plus the real tools it bundles, so tools are picked from the live catalog
 * instead of being typed by hand.
 */
export function GroupsEditor({ disabled, groups, toolNames, onChange }: GroupsEditorProps): ReactElement {
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

  return (
    <div className={CLASSES.groups}>
      {groups.map((group, index) => {
        const position = index + 1
        const invalid = group.identifier === '' || !IDENTIFIER_PATTERN.test(group.identifier)
        const duplicate = !invalid && duplicates.has(index)
        return (
          // eslint-disable-next-line react/no-array-index-key -- a draft group has no identity until the host saves it
          <section className={CLASSES.group} key={`group-${index}`}>
            <header className={CLASSES.groupHeader}>
              <span className={CLASSES.rowName}>{group.identifier === '' ? `未命名分组 ${position}` : group.identifier}</span>
              <ToolActivatorButton
                disabled={disabled === true}
                onClick={() => onChange(groups.filter((_group, at) => at !== index).map(item => ({ ...item })))}
                size="sm"
                variant="ghost"
              >
                {`删除第 ${position} 组`}
              </ToolActivatorButton>
            </header>
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
                <div className={CLASSES.choices}>
                  {toolNames.map(tool => (
                    <ToolActivatorCheckbox
                      checked={group.tools.includes(tool)}
                      className={CLASSES.choice}
                      disabled={disabled}
                      key={tool}
                      label={tool}
                      onChange={checked => replace(index, {
                        ...group,
                        tools: checked ? [...group.tools, tool] : group.tools.filter(name => name !== tool),
                      })}
                    />
                  ))}
                </div>
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
          </section>
        )
      })}
      {groups.length === 0 ? <p className={CLASSES.help}>还没有分组；不分组时每个工具各自作为一个条目。</p> : null}
      <div className={CLASSES.toolbar}>
        <ToolActivatorButton
          disabled={disabled === true}
          onClick={() => onChange([...groups.map(group => ({ ...group })), emptyGroup()])}
          size="sm"
          variant="outline"
        >
          添加分组
        </ToolActivatorButton>
      </div>
    </div>
  )
}
