import { deviceCloseAgentTool, deviceInstallAgentTool, deviceListAgentTool, deviceOpenAgentTool, deviceScreenshotAgentTool } from '../../../devices/device-tools'
import { readExternalDocCommentsAgentTool, writeExternalDocCommentAgentTool } from '../../../docs/comment-tools'
import {
  createWorkAgentTool,
  findWorksAgentTool,
  readWorkAgentTool,
  updateWorkAgentTool,
} from './work-tools'
import { renderArtifactAgentTool } from './artifact-tools'
import { requestWorkReviewAgentTool } from './work-review-tools'
import {
  createAutomationAgentTool,
  deleteAutomationAgentTool,
  listAutomationRunsAgentTool,
  listAutomationsAgentTool,
  readAutomationAgentTool,
  readAutomationRunAgentTool,
  runAutomationAgentTool,
  updateAutomationAgentTool,
} from './automation-tools'
import {
  listAgentTargetsAgentTool,
  readSessionAgentTool,
  readSessionExchangeAgentTool,
  readTaskSessionsAgentTool,
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
  linkAgentTool,
  listSessionPullRequestsAgentTool,
  listTasksAgentTool,
  readTaskAgentTool,
  updateTaskStatusAgentTool,
} from './task-tools'
import {
  createExternalDocAgentTool,
  importExternalDocAgentTool,
  publishWorkAgentTool,
  pullWorkUpstreamAgentTool,
  readExternalDocAgentTool,
  searchExternalDocAgentTool,
  updateExternalDocAgentTool,
} from '../../../docs/doc-tools'
import { connectionStatusAgentTool } from '../../../connections/connection-tools'
import { queryInsightsAgentTool } from './insights-tools'
import {
  browserAppearanceAgentTool,
  browserClickAgentTool,
  browserCloseAgentTool,
  browserEvaluateAgentTool,
  browserNavigateAgentTool,
  browserOpenAgentTool,
  browserPressAgentTool,
  browserRecordStartAgentTool,
  browserRecordStopAgentTool,
  browserResizeAgentTool,
  browserScrollAgentTool,
  browserSnapshotAgentTool,
  browserStatusAgentTool,
  browserTypeAgentTool,
  browserWaitForAgentTool,
} from '../../../browser/browser-tools'
import { readConfigAgentTool, updateConfigAgentTool } from './config-tools'
import { moveToWorktreeAgentTool } from './worktree-tools'
import { askJevAgentTool } from '../../../typesafe/jev-tool'
import { watchPullRequestAgentTool } from './pull-request-watch-tool'

export const solusToolbox = {
  intelligence: {
    askJev: askJevAgentTool,
  },
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
  docs: {
    readComments: readExternalDocCommentsAgentTool,
    writeComment: writeExternalDocCommentAgentTool,
    search: searchExternalDocAgentTool,
    read: readExternalDocAgentTool,
    create: createExternalDocAgentTool,
    update: updateExternalDocAgentTool,
    import: importExternalDocAgentTool,
  },
  artifact: {
    render: renderArtifactAgentTool,
  },
  automations: {
    create: createAutomationAgentTool,
    list: listAutomationsAgentTool,
    read: readAutomationAgentTool,
    update: updateAutomationAgentTool,
    delete: deleteAutomationAgentTool,
    run: runAutomationAgentTool,
    listRuns: listAutomationRunsAgentTool,
    readRun: readAutomationRunAgentTool,
  },
  connections: {
    status: connectionStatusAgentTool,
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
    type: browserTypeAgentTool,
    press: browserPressAgentTool,
    scroll: browserScrollAgentTool,
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
    targets: listAgentTargetsAgentTool,
    search: searchSessionsAgentTool,
    read: readSessionAgentTool,
    exchange: readSessionExchangeAgentTool,
    readTask: readTaskSessionsAgentTool,
    start: startSessionAgentTool,
    send: sendSessionAgentTool,
    stop: stopSessionAgentTool,
    moveToWorktree: moveToWorktreeAgentTool,
  },
  tasks: {
    list: listTasksAgentTool,
    read: readTaskAgentTool,
    updateStatus: updateTaskStatusAgentTool,
    create: createTaskAgentTool,
    comment: commentTaskAgentTool,
    link: linkAgentTool,
    listSessionPullRequests: listSessionPullRequestsAgentTool,
    watchPullRequest: watchPullRequestAgentTool,
  },
  config: {
    read: readConfigAgentTool,
    update: updateConfigAgentTool,
  },
} as const
