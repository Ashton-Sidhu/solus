
// Canonical home is shared/types.ts so renderer and main share one encoder.
// Re-exported here to keep existing `../utils` import sites stable.
export { encodePathAsFolder } from '@solus/contracts/types'
export { stripInjectedContext } from '@solus/contracts/injected-context'
