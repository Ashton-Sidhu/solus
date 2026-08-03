import { track } from '@renderer/lib/analytics'
import {
  BrowserRouteHistory,
  RouterStore,
  type Route,
} from '@renderer/contexts/workspace/routing'

export const router = new RouterStore(new BrowserRouteHistory(), { track })
export type { Route }
