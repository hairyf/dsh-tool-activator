import type { ActivatedToolInfo, ActivateSkillParams, ActivateToolsParams, ActivationResult, ActivatorRuntimeService } from './types'

export class ActivatorExecutionRuntime {
  constructor(private readonly service: ActivatorRuntimeService) {}

  async activateSkill(args: ActivateSkillParams): Promise<ActivationResult> {
    if (!this.service.activateSkill)
      return { content: 'Skill activation is not available.', success: false }

    return this.service.activateSkill(args)
  }

  async activateTools(args: ActivateToolsParams): Promise<ActivationResult> {
    const { identifiers } = args
    if (!identifiers || identifiers.length === 0) {
      return {
        content: 'No tool identifiers provided. Please specify which tools to activate.',
        success: false,
      }
    }

    try {
      const activeIdentifiers = new Set(this.service.getActiveIdentifiers(identifiers))
      const toActivate: string[] = []
      const alreadyActiveList: string[] = []
      for (const id of identifiers) {
        if (activeIdentifiers.has(id))
          alreadyActiveList.push(id)
        else
          toActivate.push(id)
      }

      const manifests = await this.service.getToolManifests(toActivate)
      const foundIdentifiers = new Set(manifests.map(manifest => manifest.identifier))
      const notFoundAsTools = toActivate.filter(id => !foundIdentifiers.has(id))
      const activatedSkillResults: ActivationResult[] = []
      const notFound: string[] = []

      if (notFoundAsTools.length > 0 && this.service.activateSkill) {
        for (const id of notFoundAsTools) {
          try {
            const result = await this.service.activateSkill({ name: id })
            if (result.success)
              activatedSkillResults.push(result)
            else
              notFound.push(id)
          }
          catch {
            notFound.push(id)
          }
        }
      }
      else {
        notFound.push(...notFoundAsTools)
      }

      const activatedTools: ActivatedToolInfo[] = manifests.map(manifest => ({
        apiCount: manifest.apiDescriptions.length,
        avatar: manifest.avatar,
        identifier: manifest.identifier,
        name: manifest.name,
        // The names travel with the receipt: they are what keeps the tools
        // callable after the group that carried them is renamed or split.
        tools: manifest.tools.map(tool => tool.name),
      }))
      if (manifests.length > 0)
        this.service.markActivated(manifests.map(manifest => manifest.identifier))

      const parts: string[] = []
      if (activatedTools.length > 0) {
        const names = manifests.flatMap(manifest => manifest.apiDescriptions.length > 0
          ? manifest.apiDescriptions.map(api => api.name)
          : [manifest.identifier])
        parts.push(`Successfully activated tools: ${names.join(', ')}.`)
        parts.push('Usage instructions for the activated items are in the system prompt.')
      }
      for (const result of activatedSkillResults)
        parts.push(result.content)
      if (alreadyActiveList.length > 0)
        parts.push(`\nAlready active: ${alreadyActiveList.join(', ')}`)
      const unexplained: string[] = []
      for (const id of notFound) {
        const explanation = this.service.explainNotFound?.(id)
        if (explanation)
          parts.push(`\nNot available: ${id}. ${explanation}`)
        else
          unexplained.push(id)
      }
      if (unexplained.length > 0)
        parts.push(`\nNot found: ${unexplained.join(', ')}`)

      return {
        content: parts.join('\n'),
        state: {
          activatedSkills: activatedSkillResults.map(result => result.state),
          activatedTools,
          alreadyActive: alreadyActiveList,
          notFound,
        },
        success: true,
      }
    }
    catch (error) {
      return {
        content: `Failed to activate tools: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
      }
    }
  }
}

/** not-found 解释能看到的上下文：本会话激活过什么、配置里还挂着哪些分组。 */
export interface NotFoundExplanationContext {
  activatedToolIds: readonly string[]
  /** 配置里仍在的分组标识符；解释只用「在不在」，不需要成员名。 */
  groups: ReadonlySet<string>
}

/**
 * 解释一个标识符为什么不在目录里，只讲插件能知道的部分。配置中的分组分支
 * 正是 #29 的卸载场景：持久化留住分组，成员背后的插件已不在注册面里；它
 * 不会遇到「部分存活」的情形——那样条目仍在目录里，轮不到 not-found。
 */
export function explainNotFound(identifier: string, context: NotFoundExplanationContext): string {
  if (context.groups.has(identifier))
    return `Group ${identifier} is still configured, but none of its tools are in the current catalog; the plugin behind it may have been uninstalled. Remove its members from the group in the tool activator settings.`
  if (context.activatedToolIds.includes(identifier))
    return `${identifier} was activated earlier in this session but is no longer in the catalog; its tools may have been uninstalled, or its group renamed or removed.`
  return `${identifier} is not in the current catalog; it may have been renamed, removed, or its tools uninstalled.`
}
