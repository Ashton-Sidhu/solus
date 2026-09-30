import { AsyncLocalStorage } from 'node:async_hooks'
import type { Principal } from './principal'

/** Set at admitted turn execution, never from model-supplied tool arguments. */
const authority = new AsyncLocalStorage<Principal>()
export function withWorkspaceToolAuthority<T>(principal: Principal, run: () => T): T { return authority.run(principal, run) }
export function workspaceToolAuthority(): Principal | undefined { return authority.getStore() }
