import type { DeviceInput } from '@solus/contracts/device-types'

/** Keep the first gesture while the native app asks the host for control. */
export class DeviceInputGate {
  private enabled = false
  private requesting = false
  private pending: DeviceInput[] = []

  constructor(private readonly send: (input: DeviceInput) => void, private readonly requestControl: () => void) {}

  push(input: DeviceInput): void {
    if (this.enabled) { this.send(input); return }
    const last = this.pending.at(-1)
    if (input.kind === 'pointer' && input.phase === 'move' && last?.kind === 'pointer' && last.phase === 'move') this.pending[this.pending.length - 1] = input
    else if (this.pending.length < 64) this.pending.push(input)
    if (this.requesting) return
    this.requesting = true
    this.requestControl()
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) return
    this.requesting = false
    const pending = this.pending
    this.pending = []
    for (const input of pending) this.send(input)
  }

  refused(): void {
    this.requesting = false
    this.pending = []
  }
}
