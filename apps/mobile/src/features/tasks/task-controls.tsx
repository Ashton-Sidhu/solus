export { ActionButton as TaskAction, FormField as TaskField } from '../../components/FormControls'

export type TaskCommand = (command: () => Promise<void>) => Promise<void>

// A caught transport or provider rejection enters here before it becomes display text.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const taskFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
