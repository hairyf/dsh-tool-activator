import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { ACTIVATOR_TOOL_NAME, DEACTIVATOR_TOOL_NAME } from './constants'
import { ToolActivatorRemote } from './remote'
import { DEFAULT_POLICY } from './shared'

function schema(name: string): ToolSchema {
  return { name, description: `${name} description`, parameters: { type: 'object', properties: {} } }
}

/** The remote only reads the registry and the live agents; a stub of both is enough. */
function remote(schemas: ToolSchema[]): ToolActivatorRemote {
  // The stub only carries what catalog() reads; the rest of the host context
  // is out of scope for these assertions.
  const ctx = { tools: { schemas: () => schemas }, agents: { list: () => [] } } as unknown as ConstructorParameters<typeof ToolActivatorRemote>[0]
  return new ToolActivatorRemote(
    ctx,
    () => ({ ...DEFAULT_POLICY }),
  )
}

describe('toolActivatorRemote.catalog', () => {
  it('keeps the two catalog managers in the base tools and the first entries', () => {
    const catalog = remote([
      schema('pwsh'),
      schema(DEACTIVATOR_TOOL_NAME),
      schema(ACTIVATOR_TOOL_NAME),
    ]).catalog()

    // The managers head the base list no matter how the registry ordered them,
    // so the page labels and sorts them ahead of everything the user added.
    expect(catalog.baseTools).toEqual([ACTIVATOR_TOOL_NAME, DEACTIVATOR_TOOL_NAME, ...DEFAULT_POLICY.basicTools])
    expect(catalog.entries[0]).toMatchObject({ identifier: ACTIVATOR_TOOL_NAME, tools: [ACTIVATOR_TOOL_NAME] })
    expect(catalog.entries[1]).toMatchObject({ identifier: DEACTIVATOR_TOOL_NAME, tools: [DEACTIVATOR_TOOL_NAME] })
    // The manager descriptions come from the live schema, not a hardcoded copy.
    expect(catalog.entries[1]?.description).toBe(`${DEACTIVATOR_TOOL_NAME} description`)
  })

  it('carries the managers as empty entries while their schemas have not registered', () => {
    const catalog = remote([]).catalog()

    // A host that has not opened a step yet exposes no schemas; the page still
    // needs the two rows it pins, so they render with nothing to hold.
    expect(catalog.entries.map(entry => entry.identifier)).toEqual([ACTIVATOR_TOOL_NAME, DEACTIVATOR_TOOL_NAME])
    expect(catalog.entries[0]?.tools).toEqual([])
    expect(catalog.entries[1]?.tools).toEqual([])
  })
})
