export type CloudOriginKind = 'unknown' | 'signed-in' | 'signed-out' | 'not-cloud'

class CloudOriginState {
  kind = $state<CloudOriginKind>('unknown')

  /** The account origin's sign-in page, returning to this client afterwards. */
  get signInUrl(): string {
    return `${location.origin}/sign-in?next=${encodeURIComponent('/')}`
  }

  /** The account origin's page that mints a code to link a machine. */
  get linkMachineUrl(): string {
    return `${location.origin}/hosts/link`
  }
}

export const cloudOrigin = new CloudOriginState()
