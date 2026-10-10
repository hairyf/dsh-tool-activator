import type { Context } from '@deepseek-ai/cordis'
import type { ActivationCatalog } from '../types'
import { TOOL_ACTIVATOR_REMOTE } from './constants'

interface RemoteEnvelope {
  error?: { message?: string }
  ok?: boolean
  value?: unknown
}

interface ConnectionLike {
  rpc?: {
    call?: (path: string, method: string, payload: { args: Record<string, unknown> }) => Promise<RemoteEnvelope>
  }
}

function rpcOf(ctx: Context): NonNullable<ConnectionLike['rpc']>['call'] | undefined {
  const connection = Reflect.get(ctx, 'connection') as ConnectionLike | undefined
  const call = connection?.rpc?.call
  return typeof call === 'function' ? call.bind(connection!.rpc) : undefined
}

export async function loadToolCatalog(ctx: Context): Promise<ActivationCatalog> {
  const call = rpcOf(ctx)
  if (!call)
    throw new Error('连接服务不可用，无法读取工具列表。')
  // A hand-written Remote reads its parameters by name, so the payload carries
  // exactly one plain-object `args` field — an empty one for a no-argument method.
  const answer = await call('/api', `${TOOL_ACTIVATOR_REMOTE}/catalog`, { args: {} })
  if (answer?.ok !== true)
    throw new Error(answer?.error?.message ?? '读取工具列表失败。')
  const catalog = answer.value as ActivationCatalog | undefined
  if (!catalog || !Array.isArray(catalog.entries))
    throw new Error('工具列表返回格式无法识别。')
  return catalog
}
