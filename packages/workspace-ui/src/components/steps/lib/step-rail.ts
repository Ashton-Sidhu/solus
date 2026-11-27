/**
 * The state of one step on a `StepRail`. A person moves through `done`,
 * `current`, and `next`; work that runs by itself (the setup card) also has
 * `failed`, `warning`, and `skipped`.
 */
export type StepRailState = 'done' | 'current' | 'next' | 'failed' | 'warning' | 'skipped'
