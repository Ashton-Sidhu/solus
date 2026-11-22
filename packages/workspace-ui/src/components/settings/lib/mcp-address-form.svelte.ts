import type { IntegrationAuthChoice, IntegrationEnvValue } from '@solus/contracts/integration-types'
import { checkAuthChoice, type AuthChoiceField, type AuthChoiceKind, type HeaderDraft } from '@solus/contracts/integrations/auth-choice'
import { customUrlProblem, urlHost } from './integration-labels'

export interface AddressFormProblem {
  field: 'address' | AuthChoiceField
  reason: string
}

/** The form as the host takes it: the server, its authentication, and the header values to give once it exists. */
export interface AddressFormCheck {
  url: string
  name: string
  auth: IntegrationAuthChoice
  values: IntegrationEnvValue[]
}

/**
 * The URL form of Add server (docs/plans/mcp-add-server.md): the address, the
 * name, and the Authentication with the fields of each choice. Ephemeral: it
 * lives as long as its dialog. The client secret and the header values are
 * secrets; `takeSecrets` clears them once they go to the host.
 */
export class McpAddressForm {
  address = $state('')
  name = $state('')
  authKind = $state<AuthChoiceKind>('automatic')
  clientId = $state('')
  clientSecret = $state('')
  scopes = $state('')
  headers = $state<HeaderDraft[]>([{ name: '', value: '' }])
  problem = $state<AddressFormProblem | null>(null)

  /** The name the server gets when the person gives none. */
  get suggestedName(): string {
    const url = this.address.trim()
    return url ? urlHost(url) : 'Linear'
  }

  problemOf(field: AddressFormProblem['field']): string | null {
    return this.problem?.field === field ? this.problem.reason : null
  }

  addHeader(): void {
    this.headers.push({ name: '', value: '' })
  }

  removeHeader(index: number): void {
    this.headers.splice(index, 1)
    if (this.headers.length === 0) this.addHeader()
  }

  /** The form as the host takes it, or null with `problem` set. */
  check(): AddressFormCheck | null {
    const url = this.address.trim()
    const urlProblem = customUrlProblem(url)
    if (urlProblem) {
      this.problem = { field: 'address', reason: urlProblem }
      return null
    }
    const choice = checkAuthChoice({ kind: this.authKind, clientId: this.clientId, clientSecret: this.clientSecret, scopes: this.scopes, headers: this.headers })
    if (!choice.ok) {
      this.problem = { field: choice.field, reason: choice.reason }
      return null
    }
    this.problem = null
    return { url, name: this.name.trim() || urlHost(url), auth: choice.auth, values: choice.values }
  }

  /** The secrets went to the host: the form keeps none. */
  takeSecrets(): void {
    this.clientSecret = ''
    for (const header of this.headers) header.value = ''
  }
}
