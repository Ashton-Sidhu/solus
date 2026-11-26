import { AppWindow, Copy, Share2 } from '@lucide/svelte'
import type { Component } from 'svelte'

/** What an access item of a host's menu does. */
export type HostMenuAccessAction = 'connect-apps' | 'copy-mcp-address' | 'sharing-access'

/**
 * The items of a host's menu on Settings → Hosts that are about outside apps and
 * access (plans/035 §10), in menu order. `needsAnswer`: the item reads from the
 * host now, so it is off while the host does not answer. Sharing & access shows
 * the host's state, and says when the host does not answer, so it stays on.
 */
export const HOST_MENU_ACCESS_ITEMS = [
  { action: 'connect-apps', label: 'Use Solus in other apps…', icon: AppWindow, needsAnswer: true },
  { action: 'copy-mcp-address', label: 'Copy MCP address', icon: Copy, needsAnswer: true },
  { action: 'sharing-access', label: 'Sharing & access', icon: Share2, needsAnswer: false },
] as const satisfies readonly { action: HostMenuAccessAction; label: string; icon: Component; needsAnswer: boolean }[]
