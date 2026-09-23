import { bigint, defineTable, text } from '../db/schema/define-table'

/**
 * The organization's project directory (docs/plans/project-model.md §2): one
 * row per repository a member added. Not the host manifest `projects`, which
 * lists folders on one machine and stays runner-local.
 */
export const workspaceProjects = defineTable('workspace_projects', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  repository_key: text({ notNull: true }),
  display_name: text({ notNull: true }),
  default_branch: text(),
  created_by: text(),
  created_at: bigint({ notNull: true }),
}, {
  indexes: [
    { name: 'workspace_projects_by_repository', columns: ['organization_id', 'repository_key'], unique: true },
  ],
})

export const PROJECT_TABLES = [workspaceProjects]
