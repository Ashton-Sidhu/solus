/**
 * A conversation that waits for a sign-in on another host
 * (docs/host-provider-sign-in.md). The person left the conversation from its
 * Sign in card for that host's AI providers tab. When the card closes (the
 * host reports the provider signed in, the run stops, or someone skips), the
 * conversation comes back if the person is still on that host's page.
 */
export interface SignInReturn {
  tabId: string
  serverId: string
  /** The Sign in card the conversation waits on. */
  questionId: string
  /** What the bar on the host page calls the conversation. */
  conversationTitle: string
  providerLabel: string
}

export interface SignInReturnRoute {
  /** The person is still on this host's page. */
  isOnHostPage: () => boolean
  /** Shows the conversation again, with its input focused. */
  showConversation: () => void
}

class SignInReturns {
  /** The one sign-in a conversation waits on; a newer one replaces it. */
  pending = $state<SignInReturn | null>(null)
  #route: SignInReturnRoute | null = null

  begin(target: SignInReturn, route: SignInReturnRoute): void {
    this.pending = target
    this.#route = route
  }

  /**
   * The session's reducer saw a card close. The conversation comes back only
   * when it is the awaited card and the person stayed on the host's page: a
   * person who went elsewhere meanwhile is not moved.
   */
  cardClosed(questionId: string): void {
    if (this.pending?.questionId !== questionId) return
    const route = this.#route
    this.cancel()
    if (route?.isOnHostPage()) route.showConversation()
  }

  /** The bar's "Back to the conversation": now, without waiting for the card. */
  goBack(): void {
    const route = this.#route
    this.cancel()
    route?.showConversation()
  }

  cancel(): void {
    this.#route = null
    this.pending = null
  }
}

export const signInReturns = new SignInReturns()
