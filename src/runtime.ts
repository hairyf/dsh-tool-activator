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
      const alreadyActive = this.service.getActivatedToolIds()
      const toActivate: string[] = []
      const alreadyActiveList: string[] = []
      for (const id of identifiers) {
        if (alreadyActive.includes(id))
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
