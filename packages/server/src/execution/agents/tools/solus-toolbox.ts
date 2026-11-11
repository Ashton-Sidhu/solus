import { delegateTaskAgentTool } from './delegate-task-tool'
import { linkAgentTool, listLinksAgentTool, unlinkAgentTool } from './session-link-tools'
import { deviceCloseAgentTool, deviceInstallAgentTool, deviceListAgentTool, deviceOpenAgentTool, deviceScreenshotAgentTool } from '../../../devices/device-tools'
import {
  createWorkAgentTool,
  findWorksAgentTool,
  readWorkAgentTool,
  updateWorkAgentTool,
} from './work-tools'
import { renderArtifactAgentTool } from './artifact-tools'
import { createAppAgentTool } from './app-tools'
import { requestWorkReviewAgentTool } from './work-review-tools'
import {
  createAutomationAgentTool,
  deleteAutomationAgentTool,
  listAutomationRunsAgentTool,
  listAutomationsAgentTool,
  readAutomationAgentTool,
  runAutomationAgentTool,
  updateAutomationAgentTool,
} from './automation-tools'
import {
  listAgentTargetsAgentTool,
  readSessionAgentTool,
  readSessionExchangeAgentTool,
  searchSessionsAgentTool,
  sendSessionAgentTool,
  startSessionAgentTool,
  stopSessionAgentTool,
} from './session-tools'
import {
  commentDocumentAgentTool,
  readPlanAgentTool,
  replyCommentAgentTool,
  resolveCommentAgentTool,
} from '../../../annotations/comment-tools'
import {
  commentTaskAgentTool,
  createTaskAgentTool,
  listTasksAgentTool,
  readTaskAgentTool,
  updateTaskStatusAgentTool,
} from './task-tools'
import { publishWorkAgentTool, pullWorkUpstreamAgentTool } from './work-sync-tools'
import { connectionStatusAgentTool } from '../../../connections/connection-tools'
import { connectIntegrationAgentTool } from '../../../integrations/connect-integration-tool'
import { queryInsightsAgentTool } from './insights-tools'
import {
  browserAppearanceAgentTool,
  browserClickAgentTool,
  browserDialogAgentTool,
  browserDragAgentTool,
  browserCloseAgentTool,
  browserEvaluateAgentTool,
  browserHoverAgentTool,
  browserNavigateAgentTool,
  browserOpenAgentTool,
  browserPressAgentTool,
  browserRecordStartAgentTool,
  browserRecordStopAgentTool,
  browserResizeAgentTool,
  browserScrollAgentTool,
  browserSelectAgentTool,
  browserSnapshotAgentTool,
  browserStatusAgentTool,
  browserTypeAgentTool,
  browserUploadAgentTool,
  browserWaitForAgentTool,
} from '../../../browser/browser-tools'
import { readConfigAgentTool, updateConfigAgentTool } from './config-tools'
import { createProjectAgentTool, cloneProjectAgentTool } from './project-tools'
import { moveToWorktreeAgentTool, worktreeStatusAgentTool } from './worktree-tools'
import { watchPullRequestAgentTool } from './pull-request-watch-tool'
import { organizeSessionAgentTool } from './session-organize-tool'
import { backgroundWaitAgentTool } from './background-wait-tool'
import { requestSecretAgentTool } from './secret-request-tool'
import {
  createWebhookAgentTool,
  deleteWebhookAgentTool,
  dryRunWebhookAgentTool,
  listWebhooksAgentTool,
  readWebhookDeliveryAgentTool,
  rotateWebhookAgentTool,
  updateWebhookAgentTool,
} from './webhook-tools'

export const solusToolbox = {
  works: {
    find: findWorksAgentTool,
    read: readWorkAgentTool,
    create: createWorkAgentTool,
    update: updateWorkAgentTool,
    readPlan: readPlanAgentTool,
    comment: commentDocumentAgentTool,
    replyComment: replyCommentAgentTool,
    resolveComment: resolveCommentAgentTool,
    publish: publishWorkAgentTool,
    pullUpstream: pullWorkUpstreamAgentTool,
    requestReview: requestWorkReviewAgentTool,
  },
  artifact: {
    render: renderArtifactAgentTool,
  },
  apps: {
    create: createAppAgentTool,
  },
  automations: {
    create: createAutomationAgentTool,
    list: listAutomationsAgentTool,
    read: readAutomationAgentTool,
    update: updateAutomationAgentTool,
    delete: deleteAutomationAgentTool,
    run: runAutomationAgentTool,
    listRuns: listAutomationRunsAgentTool,
  },
  webhooks: {
    create: createWebhookAgentTool,
    update: updateWebhookAgentTool,
    delete: deleteWebhookAgentTool,
    rotate: rotateWebhookAgentTool,
    list: listWebhooksAgentTool,
    readDelivery: readWebhookDeliveryAgentTool,
    dryRun: dryRunWebhookAgentTool,
  },
  connections: {
    status: connectionStatusAgentTool,
    connectIntegration: connectIntegrationAgentTool,
  },
  insights: {
    query: queryInsightsAgentTool,
  },
  browser: {
    status: browserStatusAgentTool,
    open: browserOpenAgentTool,
    close: browserCloseAgentTool,
    navigate: browserNavigateAgentTool,
    resize: browserResizeAgentTool,
    setAppearance: browserAppearanceAgentTool,
    snapshot: browserSnapshotAgentTool,
    recordStart: browserRecordStartAgentTool,
    recordStop: browserRecordStopAgentTool,
    click: browserClickAgentTool,
    hover: browserHoverAgentTool,
    type: browserTypeAgentTool,
    select: browserSelectAgentTool,
    press: browserPressAgentTool,
    scroll: browserScrollAgentTool,
    drag: browserDragAgentTool,
    upload: browserUploadAgentTool,
    dialog: browserDialogAgentTool,
    evaluate: browserEvaluateAgentTool,
    waitFor: browserWaitForAgentTool,
  },
  devices: {
    list: deviceListAgentTool,
    open: deviceOpenAgentTool,
    screenshot: deviceScreenshotAgentTool,
    close: deviceCloseAgentTool,
    install: deviceInstallAgentTool,
  },
  sessions: {
    requestSecret: requestSecretAgentTool,
    targets: listAgentTargetsAgentTool,
    search: searchSessionsAgentTool,
    read: readSessionAgentTool,
    exchange: readSessionExchangeAgentTool,
    start: startSessionAgentTool,
    delegate: delegateTaskAgentTool,
    send: sendSessionAgentTool,
    stop: stopSessionAgentTool,
    organize: organizeSessionAgentTool,
    watchPullRequest: watchPullRequestAgentTool,
    unlink: unlinkAgentTool,
    listLinks: listLinksAgentTool,
    link: linkAgentTool,
    backgroundWait: backgroundWaitAgentTool,
    worktreeStatus: worktreeStatusAgentTool,
    moveToWorktree: moveToWorktreeAgentTool,
  },
  projects: {
    create: createProjectAgentTool,
    clone: cloneProjectAgentTool,
  },
  tasks: {
    list: listTasksAgentTool,
    read: readTaskAgentTool,
    updateStatus: updateTaskStatusAgentTool,
    create: createTaskAgentTool,
    comment: commentTaskAgentTool,
  },
  config: {
    read: readConfigAgentTool,
    update: updateConfigAgentTool,
  },
} as const
