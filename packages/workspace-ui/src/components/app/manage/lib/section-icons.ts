import {
  Activity as ActivityIcon,
  Braces as OperationsIcon,
  Clock as SchedulesIcon,
  Files as FilesIcon,
  FolderGit2 as SourceIcon,
  Gauge as OverviewIcon,
  KeyRound as SecretsIcon,
  Layers as VersionsIcon,
  MessagesSquare as SessionsIcon,
  RadioTower as SignalsIcon,
  SlidersHorizontal as ConfigIcon,
  Sparkles as ModelsIcon,
  Webhook as WebhooksIcon,
  Workflow as WorkflowsIcon,
} from '@lucide/svelte'
import type { AppManageSection } from '../../../../contexts/workspace/routing/route-registry'

/** The icon of each section of the Manage page, for its rail and its strip. */
export const MANAGE_SECTION_ICONS = {
  overview: OverviewIcon,
  activity: ActivityIcon,
  workflows: WorkflowsIcon,
  versions: VersionsIcon,
  schedules: SchedulesIcon,
  webhooks: WebhooksIcon,
  signals: SignalsIcon,
  models: ModelsIcon,
  secrets: SecretsIcon,
  config: ConfigIcon,
  files: FilesIcon,
  operations: OperationsIcon,
  sessions: SessionsIcon,
  source: SourceIcon,
} satisfies { [Section in AppManageSection]: typeof OverviewIcon }
