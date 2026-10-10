import type * as RendererModule from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import * as cordis from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import CssRender from 'css-render'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ToolActivatorConfiguration } from './configuration-page'
import { CONFIGURATION_ID, CONFIGURATION_REGISTRANT, CONFIGURATION_SLOT, STYLE_ID } from './constants'
import * as plugin from './index'

const modules: Readonly<Record<string, unknown>> = {
  'react': React,
  'react-dom': ReactDom,
  'react-dom/client': ReactDomClient,
  'react/jsx-runtime': JsxRuntime,
  '@deepseek-ai/cordis': cordis,
  '@deepseek-ai/dsh-client-ui-slots': slots,
}
let SlotRegistry: typeof RendererModule.SlotRegistry
const originalLoader = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')

beforeAll(async () => {
  Object.defineProperty(window, '__ModuleLoader__', {
    configurable: true,
    value: {
      load(definition: { factory: (require: (id: string) => unknown) => unknown }): void {
        const loaded = definition.factory((id) => {
          if (!(id in modules))
            throw new Error(`Unexpected browser module dependency: ${id}`)
          return modules[id]
        }) as typeof RendererModule
        SlotRegistry = loaded.SlotRegistry
      },
    },
  })
  await import('@deepseek-ai/dsh-client-ui-renderer/client')
})

const disposers: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse())
    await dispose()
  CssRender().find(STYLE_ID)?.remove()
})

afterAll(() => {
  if (originalLoader)
    Object.defineProperty(window, '__ModuleLoader__', originalLoader)
  else
    Reflect.deleteProperty(window, '__ModuleLoader__')
})

function declareConfigurationSlot(ctx: Context): () => void {
  return ctx.slots.register({
    name: 'root',
    children: {
      [CONFIGURATION_SLOT]: { kind: 'keyed', scope: 'root' },
    },
  }, ({ renderSlot }: PropsRenderSlots<typeof CONFIGURATION_SLOT>) => renderSlot(CONFIGURATION_SLOT, { view: 'page' }, { entryKey: CONFIGURATION_ID }))
}

describe('official row configuration plugin lifecycle', () => {
  it('registers only the stable official keyed slot and cleans up on unload', async () => {
    const ctx = new Context()
    const rendererFiber = await ctx.plugin(SlotRegistry)
    disposers.push(() => rendererFiber.dispose())
    const disposeOwner = declareConfigurationSlot(ctx)
    const fiber = await ctx.plugin(plugin)
    disposers.push(() => fiber.dispose())
    const entries = ctx.slots.entries(CONFIGURATION_SLOT)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ options: { key: CONFIGURATION_ID }, registrant: CONFIGURATION_REGISTRANT, component: ToolActivatorConfiguration })
    expect(CssRender().find(STYLE_ID)).not.toBeNull()
    await fiber.dispose()
    expect(ctx.slots.entries(CONFIGURATION_SLOT)).toHaveLength(0)
    expect(CssRender().find(STYLE_ID)).toBeNull()
    disposeOwner()
  })

  it('waits for the official owner declaration and reinstalls after owner reload', async () => {
    const ctx = new Context()
    const rendererFiber = await ctx.plugin(SlotRegistry)
    disposers.push(() => rendererFiber.dispose())
    const fiber = await ctx.plugin(plugin)
    disposers.push(() => fiber.dispose())
    expect(ctx.slots.entries(CONFIGURATION_SLOT)).toHaveLength(0)
    const disposeOwner = declareConfigurationSlot(ctx)
    expect(ctx.slots.entries(CONFIGURATION_SLOT)).toHaveLength(1)
    disposeOwner()
    expect(ctx.slots.entries(CONFIGURATION_SLOT)).toHaveLength(0)
    const disposeReplacement = declareConfigurationSlot(ctx)
    expect(ctx.slots.entries(CONFIGURATION_SLOT)).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries(CONFIGURATION_SLOT)).toHaveLength(0)
    disposeReplacement()
  })

  it('does not remove styles borrowed from another client instance on unload', async () => {
    const ctx = new Context()
    const rendererFiber = await ctx.plugin(SlotRegistry)
    disposers.push(() => rendererFiber.dispose())
    const externalStyle = CssRender().c(`.${STYLE_ID}`, { display: 'block' })
    externalStyle.mount({ id: STYLE_ID, head: true })
    const ownedElsewhere = CssRender().find(STYLE_ID)
    const fiber = await ctx.plugin(plugin)
    disposers.push(() => fiber.dispose())
    await fiber.dispose()
    expect(CssRender().find(STYLE_ID)).toBe(ownedElsewhere)
    externalStyle.unmount({ id: STYLE_ID })
  })
})
