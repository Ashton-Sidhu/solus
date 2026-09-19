import { WORK_TABLES } from '../../folio/schema'
import { PLAN_TABLES } from '../../plans/schema'
import { SESSION_TABLES } from '../../sessions/schema'
import { SHARING_TABLES } from '../../sharing/schema'
import { TASK_TABLES } from '../../tasks/schema'
import type { TableDefinition } from './define-table'

/** Every table a ported domain declares. A domain adds its list here when it is ported. */
export const PORTED_TABLES: readonly TableDefinition[] = [...TASK_TABLES, ...WORK_TABLES, ...PLAN_TABLES, ...SHARING_TABLES, ...SESSION_TABLES]
