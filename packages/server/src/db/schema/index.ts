import { TASK_TABLES } from '../../tasks/schema'
import type { TableDefinition } from './define-table'

/** Every table a ported domain declares. A domain adds its list here when it is ported. */
export const PORTED_TABLES: readonly TableDefinition[] = [...TASK_TABLES]
