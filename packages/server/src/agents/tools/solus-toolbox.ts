import {
  createWorkAgentTool,
  listWorksAgentTool,
  readWorkAgentTool,
  searchWorksAgentTool,
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
  setAutomationEnabledAgentTool,
  updateAutomationAgentTool,
} from '../../automations/automation-tools'
import {
  createSessionAgentTool,
  listAgentTargetsAgentTool,
  listSessionsAgentTool,
  promptSessionAgentTool,
  readSessionAgentTool,
  searchSessionsAgentTool,
  stopSessionAgentTool,
  waitForSessionAgentTool,
} from '../../sessions/session-tools'
import { answerSessionAgentTool, reviewPlanAgentTool } from '../../sessions/session-review-tools'
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
  linkTaskSessionAgentTool,
  listTasksAgentTool,
  readTaskAgentTool,
  updateTaskStatusAgentTool,
} from '../../tasks/task-tools'
import {
  listPrThreadsAgentTool,
  listPrsAgentTool,
  readPrAgentTool,
  replyPrThreadAgentTool,
  resolvePrThreadAgentTool,
  submitPrReviewAgentTool,
} from '../../providers/pr-tools'
import {
  createDocAgentTool,
  importDocAgentTool,
  publishWorkAgentTool,
  pullWorkUpstreamAgentTool,
  readDocAgentTool,
  searchDocsAgentTool,
  updateDocAgentTool,
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
  browserResizeAgentTool,
  browserScrollAgentTool,
  browserSnapshotAgentTool,
  browserStatusAgentTool,
  browserTypeAgentTool,
  browserWaitForAgentTool,
} from '../../browser/browser-tools'
import { readConfigAgentTool, updateConfigAgentTool } from '../../server/config-tools'

export const solusToolbox = {
  works: {
    list: listWorksAgentTool,
    search: searchWorksAgentTool,
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
    search: searchDocsAgentTool,
    read: readDocAgentTool,
    create: createDocAgentTool,
    update: updateDocAgentTool,
    import: importDocAgentTool,
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
    setEnabled: setAutomationEnabledAgentTool,
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
    click: browserClickAgentTool,
    type: browserTypeAgentTool,
    press: browserPressAgentTool,
    scroll: browserScrollAgentTool,
    evaluate: browserEvaluateAgentTool,
    waitFor: browserWaitForAgentTool,
  },
  sessions: {
    targets: listAgentTargetsAgentTool,
    list: listSessionsAgentTool,
    read: readSessionAgentTool,
    search: searchSessionsAgentTool,
    create: createSessionAgentTool,
    prompt: promptSessionAgentTool,
    wait: waitForSessionAgentTool,
    stop: stopSessionAgentTool,
    answer: answerSessionAgentTool,
    reviewPlan: reviewPlanAgentTool,
  },
  tasks: {
    list: listTasksAgentTool,
    read: readTaskAgentTool,
    updateStatus: updateTaskStatusAgentTool,
    create: createTaskAgentTool,
    comment: commentTaskAgentTool,
    linkSession: linkTaskSessionAgentTool,
    link: linkTaskAgentTool,
  },
  prs: {
    list: listPrsAgentTool,
    read: readPrAgentTool,
    listThreads: listPrThreadsAgentTool,
    replyThread: replyPrThreadAgentTool,
    resolveThread: resolvePrThreadAgentTool,
    submitReview: submitPrReviewAgentTool,
  },
  config: {
    read: readConfigAgentTool,
    update: updateConfigAgentTool,
  },
} as const
