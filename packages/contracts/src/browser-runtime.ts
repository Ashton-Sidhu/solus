/** Host-owned browser installation. Downloads continue when a client leaves. */
export interface BrowserRuntimeStatus {
  phase: 'builtin' | 'ready' | 'missing' | 'installing' | 'failed' | 'unsupported'
  message: string
  manualCommand?: string
}
