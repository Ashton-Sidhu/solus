import { getKeybindingsContext, type KeybindingsContext } from './dispatcher.svelte'
import type { BindingId } from './manifest'
import type { Handler, KeyCombo, RegisterOptions, Scope } from './types'

/**
 * Register a handler for a named binding.
 * Must be called during component initialisation (synchronous script).
 * The effect re-registers whenever `handler` or `opts.enabled` identity changes.
 * Pass a getter `() => BindingId` when the id comes from a reactive prop so the
 * effect re-tracks it instead of only capturing the initial value.
 */
export function useKeybinding(
  id: BindingId | (() => BindingId),
  handler: Handler,
  opts: RegisterOptions = {},
): void {
  const ctx = getKeybindingsContext()
  const getId = typeof id === 'function' ? id : () => id
  $effect(() => {
    return ctx.register(getId(), handler, opts)
  })
}

/**
 * Push a scope while the calling component is mounted (optionally gated by `active`).
 * When `active` returns false, the scope is temporarily popped.
 *
 * `pre: true` uses `$effect.pre` so the scope is pushed before child components'
 * effects run. This is required for parent components that use `exclusive: true`,
 * so child scopes (pushed by child effects) land above the exclusive scope in the
 * stack and aren't blocked by it.
 *
 * Pass a getter `() => Scope` when the scope comes from a reactive prop so the
 * effect re-tracks it instead of only capturing the initial value.
 */
export function useScope(
  scope: Scope | (() => Scope),
  opts: { exclusive?: boolean; active?: () => boolean; pre?: boolean } = {},
): void {
  const ctx = getKeybindingsContext()
  const getScope = typeof scope === 'function' ? scope : () => scope
  const register = () => {
    if (opts.active && !opts.active()) return
    return ctx.pushScope(getScope(), opts.exclusive)
  }
  if (opts.pre) {
    $effect.pre(register)
  } else {
    $effect(register)
  }
}

/**
 * Mount the global keybinding scope and the single document-level dispatcher.
 * Shared by both the desktop and web `App.svelte` shells so they stay in sync.
 *
 * The listener is registered in the BUBBLE phase (no capture flag) so subtree
 * handlers — most importantly the chat composer's Tiptap editor — see the event
 * first. This is what lets Shift+Enter insert a newline instead of being claimed
 * by a global binding before the editor handles it.
 */
export function installGlobalDispatcher(
  ctx: KeybindingsContext,
  getOverrides: () => Record<string, KeyCombo>,
): void {
  useScope('global')
  $effect(() => {
    ctx.setOverrides(getOverrides())
  })
  $effect(() => {
    const dispatch = (e: KeyboardEvent) => ctx.dispatch(e)
    document.addEventListener('keydown', dispatch)
    return () => document.removeEventListener('keydown', dispatch)
  })
}
