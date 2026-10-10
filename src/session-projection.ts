import type {} from '@deepseek-ai/dsh-session-projection'
import type { ACTIVATION_PROJECTION_KEY } from './constants'
import type { ActivationHistory } from './types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    [ACTIVATION_PROJECTION_KEY]: ActivationHistory
  }
}
