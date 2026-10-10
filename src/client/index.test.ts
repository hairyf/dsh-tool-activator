import type * as RendererModule from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigurationScope } from './types'
import * as cordis from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ToolActivatorConfiguration } from './configuration-page'
import { CONFIGURATION_KEY, CONFIGURATION_REGISTRANT, CONFIGURATION_SLOT, STYLE_TAG_ID } from './constants'
import * as plugin from './index'
import { ownedStyleTag } from './styles'

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
  document.querySelectorAll('style[data-plugin-css]').forEach(tag => tag.remove())
})

afterAll(() => {
  if (originalLoader)
    Object.defineProperty(window, '__ModuleLoader__', originalLoader)
  else
    Reflect.deleteProperty(window, '__ModuleLoader__')
})

const scope: ConfigurationScope = {
  getSnapshot: () => ({ mode: 'host', revision: 1, status: 'ready', value: {}, writable: true }),
  mutate: vi.fn(async () => true),
  subscribe: () => () => {},
}

async function provideConfigForms(ctx: Context): Promise<() => Promise<void>> {
  const fiber = await ctx.plugin({
    name: 'test-config-forms',
    apply(owner: Context): void {
      owner.provide('configForms', { get: () => scope })
    },
  })
  return () => fiber.dispose()
}

function declareConfigurationSlot(ctx: Context): () => void {
  return ctx.slots.register({
    name: 'root',
    children: {
      [CONFIGURATION_SLOT]: { kind: 'keyed', scope: 'root' },
    },
  }, ({ renderSlot }: PropsRenderSlots<typeof CONFIGURATION_SLOT>) => renderSlot(CONFIGURATION_SLOT, { view: 'page' }, { entryKey: CONFIGURATION_KEY }))
}

async function fixture(): Promise<Context> {
  const ctx = new Context()
  const rendererFiber = await ctx.plugin(SlotRegistry)
  disposers.push(() => rendererFiber.dispose())
  disposers.push(await provideConfigForms(ctx))
  return ctx
}

describe('official bundle configuration lifecycle', () => {
  it('registers the bundle keyed slot and cleans up on unload', async () => {
    const ctx = await fixture()
    const disposeOwner = declareConfigurationSlot(ctx)
    const fiber = await ctx.plugin(plugin)
    disposers.push(() => fiber.dispose())

    const entries = ctx.slots.entries(CONFIGURATION_SLOT)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      options: { key: CONFIGURATION_KEY },
      registrant: CONFIGURATION_REGISTRANT,
      component: ToolActivatorConfiguration,
    })
    expect(ownedStyleTag()).not.toBeNull()
    expect(ownedStyleTag()?.dataset.pluginCss).toBe(STYLE_TAG_ID)

    await fiber.dispose()
    expect(ctx.slots.entries(CONFIGURATION_SLOT)).toHaveLength(0)
    expect(ownedStyleTag()).toBeNull()
    disposeOwner()
  })

  it('waits for the official owner declaration and reinstalls after owner reload', async () => {
    const ctx = await fixture()
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
    const ctx = await fixture()
    const externalStyle = document.createElement('style')
    externalStyle.dataset.pluginCss = STYLE_TAG_ID
    externalStyle.textContent = '.borrowed-style{display:block}'
    document.head.append(externalStyle)

    const fiber = await ctx.plugin(plugin)
    disposers.push(() => fiber.dispose())
    await fiber.dispose()

    expect(ownedStyleTag()).toBe(externalStyle)
    externalStyle.remove()
  })
})
