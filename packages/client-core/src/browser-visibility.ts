/** Browser visibility belongs to this device, not the host running its agents. */
export function isBrowserVisible(): Promise<boolean> {
  // A visible but unfocused window still shows the conversation, as on desktop.
  return Promise.resolve(globalThis.document?.visibilityState === 'visible')
}
