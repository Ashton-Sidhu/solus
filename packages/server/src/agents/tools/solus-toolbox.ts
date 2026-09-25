import { readExternalDocCommentsAgentTool, writeExternalDocCommentAgentTool } from '../../docs/comment-tools'
import {
  createWorkAgentTool,
  findWorksAgentTool,
  readWorkAgentTool,
  updateWorkAgentTool,
} from '../../folio/work-tools'
import { renderArtifactAgentTool } from '../../folio/artifact-tools'
import {
  createAutomationAgentTool,
  deleteAutomationAgentTool,
  listAutomationRunsAgentTool,
  listAutomationsAgentTool,
  readAutomationAgentTool,
  readAutomationRunAgentTool,
  runAutomationAgentTool,
  updateAutomationAgentTool,
} from '../../automations/automation-tools'
import { cancelWatchAgentTool, listWatchesAgentTool, watchAgentTool } from '../../watches/watch-tools'
import {
  listAgentTargetsAgentTool,
  readSessionAgentTool,
  readTaskSessionsAgentTool,
  searchSessionsAgentTool,
  sendSessionAgentTool,
  startSessionAgentTool,
  stopSessionAgentTool,
} from '../../sessions/session-tools'
import {
  commentDocumentAgentTool,
  readPlanAgentTool,
  replyCommentAgentTool,
  resolveCommentAgentTool,
} from '../../annotations/comment-tools'
import {
  commentTaskAgentTool,
  createTaskAgentTool,
  linkTaskAgentTool,
  listTasksAgentTool,
  readTaskAgentTool,
  updateTaskStatusAgentTool,
} from '../../tasks/task-tools'
import {
  createExternalDocAgentTool,
  importExternalDocAgentTool,
  publishWorkAgentTool,
  pullWorkUpstreamAgentTool,
  readExternalDocAgentTool,
  searchExternalDocAgentTool,
  updateExternalDocAgentTool,
} from '../../docs/doc-tools'
import { connectionStatusAgentTool } from '../../connections/connection-tools'
import { queryInsightsAgentTool } from '../../observability/insights-tools'
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
} from '../../browser/browser-tools'
import { readConfigAgentTool, updateConfigAgentTool } from '../../server/config-tools'
import { askJevAgentTool } from '../../typesafe/jev-tool'

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
  watches: {
    watch: watchAgentTool,
    list: listWatchesAgentTool,
    cancel: cancelWatchAgentTool,
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
  sessions: {
    targets: listAgentTargetsAgentTool,
    search: searchSessionsAgentTool,
    read: readSessionAgentTool,
    readTask: readTaskSessionsAgentTool,
    start: startSessionAgentTool,
    send: sendSessionAgentTool,
    stop: stopSessionAgentTool,
  },
  tasks: {
    list: listTasksAgentTool,
    read: readTaskAgentTool,
    updateStatus: updateTaskStatusAgentTool,
    create: createTaskAgentTool,
    comment: commentTaskAgentTool,
    link: linkTaskAgentTool,
  },
  config: {
    read: readConfigAgentTool,
    update: updateConfigAgentTool,
  },
} as const
