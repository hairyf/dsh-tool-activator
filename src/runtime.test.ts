import type { ActivateToolsParams, ActivationResult, ActivatorRuntimeService, ToolManifestInfo } from './types'
import { describe, expect, it, vi } from 'vitest'
import { ActivatorExecutionRuntime } from './runtime'

const repositoryManifest: ToolManifestInfo = {
  apiDescriptions: [
    { description: 'Detailed repository search documentation.', name: 'repo_search' },
    { description: 'Detailed issue creation documentation.', name: 'repo_create_issue' },
  ],
  avatar: '🔧',
  identifier: 'repository',
  name: 'Repository',
  systemRole: 'Full repository operating instructions belong in the system prompt.',
}

function createService(overrides: Partial<ActivatorRuntimeService> = {}): ActivatorRuntimeService {
  return {
    getActivatedToolIds: vi.fn((): string[] => []),
    getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockResolvedValue([]),
    markActivated: vi.fn<ActivatorRuntimeService['markActivated']>(),
    ...overrides,
  }
}

// These cases pin the pure activation runtime contract. The host adapter, not this
// runtime, owns authorization, persistence and deduplication, so the returned content
// deliberately lists actual native tool names rather than a group.api style notation.
describe('activatorExecutionRuntime', () => {
  describe('activateSkill', () => {
    it('reports unsupported skill activation without inventing a service', async () => {
      const service = createService()
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateSkill({ name: 'presentation' })).toEqual({
        content: 'Skill activation is not available.',
        success: false,
      })
      expect(service.getActivatedToolIds).not.toHaveBeenCalled()
      expect(service.getToolManifests).not.toHaveBeenCalled()
      expect(service.markActivated).not.toHaveBeenCalled()
    })

    it('delegates skill arguments and preserves the service result', async () => {
      const result: ActivationResult = {
        content: 'Follow these skill instructions.',
        state: { id: 'skill-1', name: 'presentation', hasResources: true },
        success: true,
      }
      const activateSkill = vi.fn<NonNullable<ActivatorRuntimeService['activateSkill']>>()
        .mockResolvedValue(result)
      const runtime = new ActivatorExecutionRuntime(createService({ activateSkill }))
      const args = { name: 'presentation' }

      expect(await runtime.activateSkill(args)).toBe(result)
      expect(activateSkill).toHaveBeenCalledExactlyOnceWith(args)
    })

    it('preserves unsuccessful direct skill results', async () => {
      const result: ActivationResult = { content: 'Skill not found.', success: false }
      const activateSkill = vi.fn<NonNullable<ActivatorRuntimeService['activateSkill']>>()
        .mockResolvedValue(result)
      const runtime = new ActivatorExecutionRuntime(createService({ activateSkill }))

      expect(await runtime.activateSkill({ name: 'missing' })).toBe(result)
    })

    it('lets the executor handle errors from direct skill activation', async () => {
      const activateSkill = vi.fn<NonNullable<ActivatorRuntimeService['activateSkill']>>()
        .mockRejectedValue(new Error('Skill store unavailable'))
      const runtime = new ActivatorExecutionRuntime(createService({ activateSkill }))

      await expect(runtime.activateSkill({ name: 'presentation' })).rejects.toThrow('Skill store unavailable')
    })
  })

  describe('activateTools', () => {
    it('rejects empty identifiers before calling any service', async () => {
      const service = createService()
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: [], reason: 'No matching tools.' })).toEqual({
        content: 'No tool identifiers provided. Please specify which tools to activate.',
        success: false,
      })
      expect(service.getActivatedToolIds).not.toHaveBeenCalled()
      expect(service.getToolManifests).not.toHaveBeenCalled()
      expect(service.markActivated).not.toHaveBeenCalled()
    })

    it('retains the upstream defensive check for missing identifiers', async () => {
      const service = createService()
      const runtime = new ActivatorExecutionRuntime(service)
      // Exercise malformed input from an untyped caller without changing the public schema.
      const args = { reason: 'Missing identifiers.' } as ActivateToolsParams

      expect(await runtime.activateTools(args)).toEqual({
        content: 'No tool identifiers provided. Please specify which tools to activate.',
        success: false,
      })
      expect(service.getActivatedToolIds).not.toHaveBeenCalled()
      expect(service.getToolManifests).not.toHaveBeenCalled()
      expect(service.markActivated).not.toHaveBeenCalled()
    })

    it('returns structured group metadata and a short list of real callable names', async () => {
      const getToolManifests = vi.fn<ActivatorRuntimeService['getToolManifests']>()
        .mockResolvedValue([repositoryManifest])
      const service = createService({ getToolManifests })
      const runtime = new ActivatorExecutionRuntime(service)

      const result = await runtime.activateTools({ identifiers: ['repository'], reason: 'Search the repository.' })

      expect(getToolManifests).toHaveBeenCalledExactlyOnceWith(['repository'])
      expect(service.markActivated).toHaveBeenCalledExactlyOnceWith(['repository'])
      expect(result).toEqual({
        content: 'Successfully activated tools: repo_search, repo_create_issue.\nUsage instructions for the activated items are in the system prompt.',
        state: {
          activatedSkills: [],
          activatedTools: [{ apiCount: 2, avatar: '🔧', identifier: 'repository', name: 'Repository' }],
          alreadyActive: [],
          notFound: [],
        },
        success: true,
      })
      expect(result.content).not.toContain(repositoryManifest.systemRole)
      for (const api of repositoryManifest.apiDescriptions)
        expect(result.content).not.toContain(api.description)
      expect(result.content).not.toContain('repository.repo_search')
    })

    it('accepts an instruction-only manifest with zero APIs', async () => {
      const manifest: ToolManifestInfo = {
        apiDescriptions: [],
        identifier: 'instructions',
        name: 'Instructions',
        systemRole: 'Instruction-only documentation.',
      }
      const service = createService({
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockResolvedValue([manifest]),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: ['instructions'], reason: 'Load instructions.' })).toEqual({
        content: 'Successfully activated tools: instructions.\nUsage instructions for the activated items are in the system prompt.',
        state: {
          activatedSkills: [],
          activatedTools: [{ apiCount: 0, avatar: undefined, identifier: 'instructions', name: 'Instructions' }],
          alreadyActive: [],
          notFound: [],
        },
        success: true,
      })
      expect(service.markActivated).toHaveBeenCalledExactlyOnceWith(['instructions'])
    })

    it('does not look up or mark identifiers that the service says are already active', async () => {
      const service = createService({
        getActivatedToolIds: vi.fn(() => ['active']),
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockResolvedValue([repositoryManifest]),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      const result = await runtime.activateTools({ identifiers: ['active', 'repository'], reason: 'Use both tools.' })

      expect(service.getToolManifests).toHaveBeenCalledExactlyOnceWith(['repository'])
      expect(service.markActivated).toHaveBeenCalledExactlyOnceWith(['repository'])
      expect(result).toMatchObject({
        state: { alreadyActive: ['active'], notFound: [] },
        success: true,
      })
      expect(result.content).toBe('Successfully activated tools: repo_search, repo_create_issue.\nUsage instructions for the activated items are in the system prompt.\n\nAlready active: active')
    })

    it('still performs an empty manifest lookup when every requested identifier is active', async () => {
      const service = createService({ getActivatedToolIds: vi.fn(() => ['active']) })
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: ['active'], reason: 'Use an active tool.' })).toEqual({
        content: '\nAlready active: active',
        state: { activatedSkills: [], activatedTools: [], alreadyActive: ['active'], notFound: [] },
        success: true,
      })
      expect(service.getToolManifests).toHaveBeenCalledExactlyOnceWith([])
      expect(service.markActivated).not.toHaveBeenCalled()
    })

    it('does not deduplicate request identifiers or the manifests returned by its service', async () => {
      const service = createService({
        getActivatedToolIds: vi.fn(() => ['active']),
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>()
          .mockResolvedValue([repositoryManifest, repositoryManifest]),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      const result = await runtime.activateTools({
        identifiers: ['active', 'repository', 'active', 'repository'],
        reason: 'Repeated requests remain a host-adapter concern.',
      })

      expect(service.getToolManifests).toHaveBeenCalledExactlyOnceWith(['repository', 'repository'])
      expect(service.markActivated).toHaveBeenCalledExactlyOnceWith(['repository', 'repository'])
      expect(result).toMatchObject({
        state: {
          activatedTools: [
            { identifier: 'repository', apiCount: 2 },
            { identifier: 'repository', apiCount: 2 },
          ],
          alreadyActive: ['active', 'active'],
        },
        success: true,
      })
      expect(result.content).toBe('Successfully activated tools: repo_search, repo_create_issue, repo_search, repo_create_issue.\nUsage instructions for the activated items are in the system prompt.\n\nAlready active: active, active')
    })

    it('reports all missing identifiers as a successful response rather than an execution error', async () => {
      const service = createService()
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: ['missing-a', 'missing-b'], reason: 'Find useful tools.' })).toEqual({
        content: '\nNot found: missing-a, missing-b',
        state: { activatedSkills: [], activatedTools: [], alreadyActive: [], notFound: ['missing-a', 'missing-b'] },
        success: true,
      })
      expect(service.markActivated).not.toHaveBeenCalled()
    })

    it('retains partial success and the order of missing identifiers', async () => {
      const service = createService({
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockResolvedValue([repositoryManifest]),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      const result = await runtime.activateTools({
        identifiers: ['missing-a', 'repository', 'missing-b'],
        reason: 'Search with the available tool.',
      })

      expect(result).toMatchObject({
        state: { activatedTools: [{ identifier: 'repository' }], notFound: ['missing-a', 'missing-b'] },
        success: true,
      })
      expect(result.content).toBe('Successfully activated tools: repo_search, repo_create_issue.\nUsage instructions for the activated items are in the system prompt.\n\nNot found: missing-a, missing-b')
      expect(service.markActivated).toHaveBeenCalledExactlyOnceWith(['repository'])
    })

    it('falls back to skills sequentially and isolates skill failures from tool activation', async () => {
      let activeFallbacks = 0
      let maxActiveFallbacks = 0
      const skillState = { id: 'skill-1', name: 'presentation', hasResources: true }
      const activateSkill = vi.fn<NonNullable<ActivatorRuntimeService['activateSkill']>>(async ({ name }) => {
        activeFallbacks++
        maxActiveFallbacks = Math.max(maxActiveFallbacks, activeFallbacks)
        await Promise.resolve()
        activeFallbacks--
        if (name === 'broken-skill')
          throw new Error('Skill loading failed')
        if (name === 'presentation')
          return { content: 'Full presentation skill instructions.', state: skillState, success: true }
        return { content: 'No such skill.', success: false }
      })
      const service = createService({
        activateSkill,
        getActivatedToolIds: vi.fn(() => ['active']),
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockResolvedValue([repositoryManifest]),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      const result = await runtime.activateTools({
        identifiers: ['repository', 'presentation', 'missing-skill', 'broken-skill', 'active'],
        reason: 'Use the repository and presentation skill.',
      })

      expect(activateSkill).toHaveBeenCalledTimes(3)
      expect(activateSkill).toHaveBeenNthCalledWith(1, { name: 'presentation' })
      expect(activateSkill).toHaveBeenNthCalledWith(2, { name: 'missing-skill' })
      expect(activateSkill).toHaveBeenNthCalledWith(3, { name: 'broken-skill' })
      expect(maxActiveFallbacks).toBe(1)
      expect(service.markActivated).toHaveBeenCalledExactlyOnceWith(['repository'])
      expect(result).toMatchObject({
        state: {
          activatedSkills: [skillState],
          activatedTools: [{ identifier: 'repository' }],
          alreadyActive: ['active'],
          notFound: ['missing-skill', 'broken-skill'],
        },
        success: true,
      })
      expect(result.content).toBe('Successfully activated tools: repo_search, repo_create_issue.\nUsage instructions for the activated items are in the system prompt.\nFull presentation skill instructions.\n\nAlready active: active\n\nNot found: missing-skill, broken-skill')
    })

    it('preserves full skill content when a missing tool activates successfully as a skill', async () => {
      const skillState = { id: 'skill-1', name: 'presentation' }
      const activateSkill = vi.fn<NonNullable<ActivatorRuntimeService['activateSkill']>>()
        .mockResolvedValue({ content: 'Full skill body and resource tree.', state: skillState, success: true })
      const service = createService({ activateSkill })
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: ['presentation'], reason: 'Create a presentation.' })).toEqual({
        content: 'Full skill body and resource tree.',
        state: { activatedSkills: [skillState], activatedTools: [], alreadyActive: [], notFound: [] },
        success: true,
      })
      expect(activateSkill).toHaveBeenCalledExactlyOnceWith({ name: 'presentation' })
      expect(service.markActivated).not.toHaveBeenCalled()
    })

    it('does not deduplicate missing identifiers before skill fallback', async () => {
      const activateSkill = vi.fn<NonNullable<ActivatorRuntimeService['activateSkill']>>()
        .mockResolvedValue({ content: 'No such skill.', success: false })
      const runtime = new ActivatorExecutionRuntime(createService({ activateSkill }))

      expect(await runtime.activateTools({ identifiers: ['missing', 'missing'], reason: 'Repeated missing IDs.' })).toEqual({
        content: '\nNot found: missing, missing',
        state: { activatedSkills: [], activatedTools: [], alreadyActive: [], notFound: ['missing', 'missing'] },
        success: true,
      })
      expect(activateSkill).toHaveBeenCalledTimes(2)
      expect(activateSkill).toHaveBeenNthCalledWith(1, { name: 'missing' })
      expect(activateSkill).toHaveBeenNthCalledWith(2, { name: 'missing' })
    })

    it('explains withheld tools while keeping unexplained identifiers in the not-found section', async () => {
      const explainNotFound = vi.fn((identifier: string) => identifier === 'device-picker'
        ? 'This run is locked to a device.'
        : undefined)
      const runtime = new ActivatorExecutionRuntime(createService({ explainNotFound }))

      expect(await runtime.activateTools({
        identifiers: ['unknown-a', 'device-picker', 'unknown-b'],
        reason: 'Find an execution target.',
      })).toEqual({
        content: '\nNot available: device-picker. This run is locked to a device.\n\nNot found: unknown-a, unknown-b',
        state: {
          activatedSkills: [],
          activatedTools: [],
          alreadyActive: [],
          notFound: ['unknown-a', 'device-picker', 'unknown-b'],
        },
        success: true,
      })
      expect(explainNotFound).toHaveBeenCalledTimes(3)
      expect(explainNotFound).toHaveBeenNthCalledWith(1, 'unknown-a')
      expect(explainNotFound).toHaveBeenNthCalledWith(2, 'device-picker')
      expect(explainNotFound).toHaveBeenNthCalledWith(3, 'unknown-b')
    })

    it('does not use the human-facing reason to choose or execute tools', async () => {
      const service = createService({
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockResolvedValue([repositoryManifest]),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      const first = await runtime.activateTools({ identifiers: ['repository'], reason: 'Search the repository.' })
      const second = await runtime.activateTools({ identifiers: ['repository'], reason: 'A different human-facing explanation.' })

      expect(second).toEqual(first)
      expect(service.getToolManifests).toHaveBeenNthCalledWith(1, ['repository'])
      expect(service.getToolManifests).toHaveBeenNthCalledWith(2, ['repository'])
      expect(service.markActivated).toHaveBeenNthCalledWith(1, ['repository'])
      expect(service.markActivated).toHaveBeenNthCalledWith(2, ['repository'])
      expect(first.content).not.toContain('Search the repository.')
      expect(second.content).not.toContain('A different human-facing explanation.')
    })

    it('returns failure when reading the current activated set throws', async () => {
      const service = createService({
        getActivatedToolIds: vi.fn(() => { throw new Error('Activation state unavailable') }),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: ['repository'], reason: 'Search.' })).toEqual({
        content: 'Failed to activate tools: Activation state unavailable',
        success: false,
      })
      expect(service.getToolManifests).not.toHaveBeenCalled()
      expect(service.markActivated).not.toHaveBeenCalled()
    })

    it('returns failure without marking tools or falling back to skills when manifest lookup rejects', async () => {
      const activateSkill = vi.fn<NonNullable<ActivatorRuntimeService['activateSkill']>>()
      const service = createService({
        activateSkill,
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>()
          .mockRejectedValue(new Error('Manifest lookup unavailable')),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: ['repository'], reason: 'Search.' })).toEqual({
        content: 'Failed to activate tools: Manifest lookup unavailable',
        success: false,
      })
      expect(service.markActivated).not.toHaveBeenCalled()
      expect(activateSkill).not.toHaveBeenCalled()
    })

    it('returns failure without a successful activation state when marking throws', async () => {
      const service = createService({
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockResolvedValue([repositoryManifest]),
        markActivated: vi.fn(() => { throw new Error('Activation write failed') }),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: ['repository'], reason: 'Search.' })).toEqual({
        content: 'Failed to activate tools: Activation write failed',
        success: false,
      })
      expect(service.markActivated).toHaveBeenCalledExactlyOnceWith(['repository'])
    })

    it('does not pretend an explanation failure rolls back a tool already marked active', async () => {
      const service = createService({
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockResolvedValue([repositoryManifest]),
        explainNotFound: vi.fn(() => { throw new Error('Unavailable explanation') }),
      })
      const runtime = new ActivatorExecutionRuntime(service)

      expect(await runtime.activateTools({ identifiers: ['repository', 'missing'], reason: 'Search.' })).toEqual({
        content: 'Failed to activate tools: Unavailable explanation',
        success: false,
      })
      expect(service.markActivated).toHaveBeenCalledExactlyOnceWith(['repository'])
      expect(service.explainNotFound).toHaveBeenCalledExactlyOnceWith('missing')
    })

    it('formats non-Error failures safely at the DSH boundary', async () => {
      const runtime = new ActivatorExecutionRuntime(createService({
        getToolManifests: vi.fn<ActivatorRuntimeService['getToolManifests']>().mockRejectedValue('Manifest lookup rejected'),
      }))

      expect(await runtime.activateTools({ identifiers: ['repository'], reason: 'Search.' })).toEqual({
        content: 'Failed to activate tools: Manifest lookup rejected',
        success: false,
      })
    })
  })
})
