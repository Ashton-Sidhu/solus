import type { BrowserPage } from './browser-types'
import type { CheckoutState } from './checkout'

/** Browser metadata is a fallback. Checkout identity has one owner. */
export function browserPageForCheckout(page: BrowserPage, state: CheckoutState | undefined): BrowserPage {
  if (!state || page.target.kind !== 'url' || page.target.worktreePath !== state.cwd) return page
  const branch = state.checkout?.branch ?? undefined
  if (page.target.branch === branch) return page
  return {
    ...page,
    target: { ...page.target, branch },
    label: page.automaticLabel ? branch ?? 'Detached HEAD' : page.label,
  }
}
