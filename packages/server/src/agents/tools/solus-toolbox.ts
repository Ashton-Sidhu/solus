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
import { cloudflareStatusAgentTool } from '../../cloudflare/cloudflare-tools'
import { queryInsightsAgentTool } from '../../observability/insights-tools'

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
  cloudflare: {
    status: cloudflareStatusAgentTool,
  },
  insights: {
    query: queryInsightsAgentTool,
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
} as const
