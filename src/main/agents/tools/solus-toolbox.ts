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
  listSessionsAgentTool,
  promptSessionAgentTool,
  readSessionAgentTool,
  searchSessionsAgentTool,
  stopSessionAgentTool,
  waitForSessionAgentTool,
} from '../../sessions/session-tools'
import {
  commentTaskAgentTool,
  createTaskAgentTool,
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

export const solusToolbox = {
  works: {
    list: listWorksAgentTool,
    search: searchWorksAgentTool,
    read: readWorkAgentTool,
    create: createWorkAgentTool,
    update: updateWorkAgentTool,
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
  sessions: {
    list: listSessionsAgentTool,
    read: readSessionAgentTool,
    search: searchSessionsAgentTool,
    create: createSessionAgentTool,
    prompt: promptSessionAgentTool,
    wait: waitForSessionAgentTool,
    stop: stopSessionAgentTool,
  },
  tasks: {
    list: listTasksAgentTool,
    read: readTaskAgentTool,
    updateStatus: updateTaskStatusAgentTool,
    create: createTaskAgentTool,
    comment: commentTaskAgentTool,
    linkSession: linkTaskSessionAgentTool,
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
