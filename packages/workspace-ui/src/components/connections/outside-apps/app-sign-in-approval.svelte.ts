import type { AppSignInRequest, SolusAPI } from '@solus/contracts/host-api'
import {
  appSignInErrorText,
  appSignInInput,
  UNKNOWN_HOST_TEXT,
  type AppSignInDecision,
  type AppSignInLinkTarget,
} from '../lib/app-sign-in'

/** The two calls that approve a sign-in, on the dialog's host. */
export type AppSignInApi = Pick<SolusAPI, 'connectionsReadAppSignIn' | 'connectionsDecideAppSignIn'>

/**
 * One "Approve a sign-in" view: the code the person typed, the sign-in it
 * names, and the decision. It lives as long as the view (a modal draft), so it
 * is not a store. A pasted `solus://approve-app` link for another known host
 * moves the view to that host (`onOtherHost`).
 */
export type AppSignInPhase =
  | { kind: 'enter' }
  | { kind: 'reading' }
  | { kind: 'shown'; request: AppSignInRequest }
  | { kind: 'deciding'; request: AppSignInRequest; decision: AppSignInDecision }
  | { kind: 'done'; request: AppSignInRequest; decision: AppSignInDecision }

export interface AppSignInApprovalDeps {
  serverId: string
  api: AppSignInApi
  /** The client's host for a link's installation id, or null when this client has no connection to it. */
  serverIdFor(hostId: string): string | null
  /** Opens the view again for a link to another host. */
  onOtherHost(serverId: string, requestId: string): void
}

export class AppSignInApproval {
  code = $state('')
  phase = $state<AppSignInPhase>({ kind: 'enter' })
  error = $state<string | null>(null)
  readonly #deps: AppSignInApprovalDeps
  /** Each read takes a number; an older answer does not replace a newer one. */
  #readCount = 0

  constructor(deps: AppSignInApprovalDeps) {
    this.#deps = deps
  }

  /** Reads the sign-in that the code field names: a check code, or a pasted link. */
  async submitCode(): Promise<void> {
    if (this.phase.kind === 'reading' || this.phase.kind === 'deciding') return
    const input = appSignInInput(this.code)
    if (input.kind === 'invalid') {
      this.error = 'Type the 8-character code from the app\'s sign-in page, as XXXX-XXXX.'
      return
    }
    if (input.kind === 'link') {
      await this.openLink(input.target)
      return
    }
    this.code = input.checkCode
    await this.#read({ checkCode: input.checkCode })
  }

  /** Shows the sign-in that a link names at once; a link to another host goes to that host. */
  async openLink(target: AppSignInLinkTarget): Promise<void> {
    const serverId = this.#deps.serverIdFor(target.hostId)
    if (serverId === null) {
      this.phase = { kind: 'enter' }
      this.error = UNKNOWN_HOST_TEXT
      return
    }
    if (serverId !== this.#deps.serverId) {
      this.#deps.onOtherHost(serverId, target.requestId)
      return
    }
    await this.#read({ requestId: target.requestId })
  }

  async decide(decision: AppSignInDecision): Promise<void> {
    if (this.phase.kind !== 'shown') return
    const { request } = this.phase
    this.phase = { kind: 'deciding', request, decision }
    this.error = null
    try {
      await this.#deps.api.connectionsDecideAppSignIn({ requestId: request.requestId, decision })
      this.phase = { kind: 'done', request, decision }
    } catch (err) {
      this.phase = { kind: 'shown', request }
      this.error = appSignInErrorText(err instanceof Error ? err.message : String(err), decision)
    }
  }

  /** Back to the code field, for another sign-in. */
  reset(): void {
    this.#readCount++
    this.code = ''
    this.phase = { kind: 'enter' }
    this.error = null
  }

  async #read(args: { requestId: string } | { checkCode: string }): Promise<void> {
    const readNumber = ++this.#readCount
    this.phase = { kind: 'reading' }
    this.error = null
    try {
      const request = await this.#deps.api.connectionsReadAppSignIn(args)
      if (readNumber !== this.#readCount) return
      this.phase = { kind: 'shown', request }
    } catch (err) {
      if (readNumber !== this.#readCount) return
      this.phase = { kind: 'enter' }
      this.error = appSignInErrorText(err instanceof Error ? err.message : String(err), 'read')
    }
  }
}
