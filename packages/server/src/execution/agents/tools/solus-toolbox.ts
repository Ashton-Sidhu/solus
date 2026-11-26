import { addHostAgentTool, removeHostAgentTool } from './host-pairing-tools'
import { createHostAgentTool, deleteHostAgentTool, restartHostAgentTool, startHostAgentTool, stopHostAgentTool } from './cloud-machine-tools'
import { checkHostAgentTool, listHostsAgentTool, shareHostAgentTool, unshareHostAgentTool, updateHostAgentTool } from './host-tools'
import { createShareLinkAgentTool, readSharingAgentTool, removeShareLinkAgentTool, shareAgentTool } from './sharing-tools'
import { listOrganizationMembersAgentTool, readOrganizationPolicyAgentTool, updateOrganizationPolicyAgentTool } from './organization-tools'
import { startSessionsAgentTool } from './start-sessions-tool'
import { queueSessionAgentTool } from './session-queue-tool'
import { listSessionsAgentTool } from './session-list-tool'
import { forkSessionAgentTool } from './session-fork-tool'
import { linkAgentTool, listLinksAgentTool, unlinkAgentTool } from './session-link-tools'
import { deviceCloseAgentTool, deviceInstallAgentTool, deviceListAgentTool, deviceOpenAgentTool, deviceScreenshotAgentTool } from '../../../devices/device-tools'
import {
  createWorkAgentTool,
  findWorksAgentTool,
  readWorkAgentTool,
  updateWorkAgentTool,
} from './work-tools'
import { renderArtifactAgentTool } from './artifact-tools'
import { checkoutAppAgentTool, deployAppAgentTool, inspectAppAgentTool, listAppsAgentTool, previewAppAgentTool, publishAppAgentTool, exportAppAgentTool, retryAppRunAgentTool, saveAppAgentTool, setAppSignalActionAgentTool, unpublishAppAgentTool } from './app-tools'
import { requestWorkReviewAgentTool } from './work-review-tools'
import {
  manageAutomationsAgentTool,
  readAutomationsAgentTool,
} from './automation-tools'
import {
  listAgentTargetsAgentTool,
  readSessionAgentTool,
  readSessionExchangeAgentTool,
  searchSessionsAgentTool,
  sendSessionAgentTool,
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
import { addMcpServerAgentTool } from '../../../integrations/add-mcp-server-tool'
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
import { readConfigAgentTool, readThemeAgentTool, updateConfigAgentTool, updateThemeAgentTool } from './config-tools'
import { attachFolderAgentTool } from './folder-tools'
import { createProjectAgentTool, cloneProjectAgentTool } from './project-tools'
import { deleteProjectAgentTool, listProjectsAgentTool, readProjectAgentTool, updateProjectAgentTool } from './project-record-tools'
import { deleteCodebaseAgentTool, listCodebasesAgentTool, readCodebaseAgentTool, updateCodebaseAgentTool } from './codebase-tools'
import { checkoutStatusAgentTool, moveCheckoutAgentTool } from './worktree-tools'
import { pullRequestTools } from './pull-request-tools'
import { pullRequestGuideTools } from './pull-request-guide-tools'
import { watchPullRequestAgentTool } from './pull-request-watch-tool'
import { organizeSessionAgentTool } from './session-organize-tool'
import { backgroundWaitAgentTool } from './background-wait-tool'
import { requestSecretAgentTool } from './secret-request-tool'
import {
  manageWebhooksAgentTool,
  readWebhooksAgentTool,
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
    save: saveAppAgentTool,
    deploy: deployAppAgentTool,
    publish: publishAppAgentTool,
    unpublish: unpublishAppAgentTool,
    export: exportAppAgentTool,
    preview: previewAppAgentTool,
    checkout: checkoutAppAgentTool,
    list: listAppsAgentTool,
    inspect: inspectAppAgentTool,
    retryRun: retryAppRunAgentTool,
    setSignalAction: setAppSignalActionAgentTool,
  },
  automations: {
    read: readAutomationsAgentTool,
    manage: manageAutomationsAgentTool,
  },
  webhooks: {
    read: readWebhooksAgentTool,
    manage: manageWebhooksAgentTool,
  },
  /**
   * Every host the person reaches (plans/036-host-tools.md). A tool that acts through
   * Solus Cloud is offered only to a person this host holds a delegation for (035 §7).
   */
  hosts: {
    list: listHostsAgentTool,
    add: addHostAgentTool,
    create: createHostAgentTool,
    start: startHostAgentTool,
    stop: stopHostAgentTool,
    restart: restartHostAgentTool,
    update: updateHostAgentTool,
    check: checkHostAgentTool,
    share: shareHostAgentTool,
    unshare: unshareHostAgentTool,
    remove: removeHostAgentTool,
    delete: deleteHostAgentTool,
  },
  connections: {
    status: connectionStatusAgentTool,
    connectIntegration: connectIntegrationAgentTool,
    addMcpServer: addMcpServerAgentTool,
  },
  /** Offered only to a person this host holds a delegation for (plans/035-cloud-machine-tools.md §7). */
  organization: {
    listMembers: listOrganizationMembersAgentTool,
    readPolicy: readOrganizationPolicyAgentTool,
    updatePolicy: updateOrganizationPolicyAgentTool,
  },
  sharing: {
    read: readSharingAgentTool,
    share: shareAgentTool,
    createLink: createShareLinkAgentTool,
    removeLink: removeShareLinkAgentTool,
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
    start: startSessionsAgentTool,
    send: sendSessionAgentTool,
    stop: stopSessionAgentTool,
    organize: organizeSessionAgentTool,
    queue: queueSessionAgentTool,
    list: listSessionsAgentTool,
    fork: forkSessionAgentTool,
    watchPullRequest: watchPullRequestAgentTool,
    ...pullRequestTools,
    ...pullRequestGuideTools,
    unlink: unlinkAgentTool,
    listLinks: listLinksAgentTool,
    link: linkAgentTool,
    backgroundWait: backgroundWaitAgentTool,
    checkoutStatus: checkoutStatusAgentTool,
    moveCheckout: moveCheckoutAgentTool,
    attachFolder: attachFolderAgentTool,
  },
  projects: {
    create: createProjectAgentTool,
    clone: cloneProjectAgentTool,
    list: listProjectsAgentTool,
    read: readProjectAgentTool,
    update: updateProjectAgentTool,
    delete: deleteProjectAgentTool,
    listCodebases: listCodebasesAgentTool,
    readCodebase: readCodebaseAgentTool,
    updateCodebase: updateCodebaseAgentTool,
    deleteCodebase: deleteCodebaseAgentTool,
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
    readTheme: readThemeAgentTool,
    updateTheme: updateThemeAgentTool,
  },
} as const
