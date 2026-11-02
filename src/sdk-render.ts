/**
 * The PTC SDK renderers have two homes across host generations: older hosts
 * export them from `@deepseek-ai/dsh-tools`, newer ones moved them into
 * `@deepseek-ai/dsh-tool-executor-ptc` when the executor split out.
 *
 * A static import cannot express that choice — a missing named export fails
 * the whole module — so probe the host at runtime and keep whichever one
 * provides the renderers.
 */

/** One tool schema as the SDK renderers accept it. */
export interface ToolSdkSchema {
  name: string
  description?: string
  parameters?: unknown
  output?: unknown
}

/** Renders the tool SDK for one language. */
export type RenderToolsSdk = (schemas: ToolSdkSchema[]) => string

export interface ToolSdkRenderers {
  renderToolsSdk: RenderToolsSdk
  renderToolsSdkPy: RenderToolsSdk
}

interface CandidateModule {
  renderToolsSdk?: unknown
  renderToolsSdkPy?: unknown
}

function pick(module: CandidateModule | undefined): ToolSdkRenderers | undefined {
  if (!module)
    return undefined
  const { renderToolsSdk, renderToolsSdkPy } = module
  if (typeof renderToolsSdk !== 'function' || typeof renderToolsSdkPy !== 'function')
    return undefined
  return {
    renderToolsSdk: renderToolsSdk as RenderToolsSdk,
    renderToolsSdkPy: renderToolsSdkPy as RenderToolsSdk,
  }
}

// Kept out of the literal form so the bundler leaves it alone: the package
// only exists in newer hosts, and hosts without it must not fail the build.
const EXECUTOR_SPECIFIER = '@deepseek-ai/dsh-tool-executor-ptc'

let renderers: ToolSdkRenderers | undefined

/**
 * Resolve the host's SDK renderers.
 *
 * @returns The renderers the installed host provides.
 * @throws When no host package exposes them.
 */
export async function loadToolSdkRenderers(): Promise<ToolSdkRenderers> {
  if (renderers)
    return renderers
  const tools = pick(await import('@deepseek-ai/dsh-tools') as unknown as CandidateModule)
  if (tools) {
    renderers = tools
    return renderers
  }
  const executor = pick(await import(/* @vite-ignore */ EXECUTOR_SPECIFIER).catch(() => undefined) as unknown as CandidateModule)
  if (executor) {
    renderers = executor
    return renderers
  }
  throw new Error('dsh-tool-activator cannot find the PTC SDK renderer in @deepseek-ai/dsh-tools or @deepseek-ai/dsh-tool-executor-ptc')
}
