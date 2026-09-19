import { getDatabase } from '../db/database'
import { readTaskPrLinks } from '../tasks/task-links'
import { listTasks, emitChanged } from '../tasks/task-store'
import { taskSessions } from '../tasks/task-sessions'
import { Task } from '../tasks/task'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
import { codeHostFor, type CodeHost } from './code-host'
import { prIndex, repoKeyOf } from './pr-index'
import { createLogger } from '../logger'

const log = createLogger('main', 'pr-link-discovery')
interface BranchInterest {
  host: CodeHost
  branch: string
  owners: Array<{ taskId: string; sessionId: string }>
}

/** Branch discovery belongs to the host, not to each sidebar mounting its tasks.
 * Only an indexed isolated checkout can establish a task link.
 * Remote attempts use their recorded branch and the task host's repository. */
export class PrLinkDiscovery {
  private readonly nextAttempt = new Map<string, number>()

  async poll(): Promise<void> {
    const interests = await this.interests()
    for (const key of this.nextAttempt.keys()) {
      if (!interests.has(key)) this.nextAttempt.delete(key)
    }
    for (const [key, interest] of interests) {
      if ((this.nextAttempt.get(key) ?? 0) > Date.now()) continue
      this.nextAttempt.set(key, Date.now() + 60_000)
      try {
        await this.refresh(interest)
      } catch (error) {
        this.nextAttempt.set(key, Date.now() + 5 * 60_000)
        log.warn('pr_branch_discovery_failed', { repository: repoKeyOf(interest.host.repo), error: String(error) })
      }
    }
  }

  private async interests(): Promise<Map<string, BranchInterest>> {
    const interests = new Map<string, BranchInterest>()
    const hosts = new Map<string, CodeHost | null>()
    const sessions = await taskSessions(LOCAL_ORGANIZATION_ID)
    for (const task of (await listTasks(LOCAL_ORGANIZATION_ID)).tasks) {
      if (!task.projectKey || task.status === 'done' || task.status === 'dropped') continue
      const attempts = (sessions[task.id] ?? []).filter((attempt) =>
        attempt.isolatedCheckout && attempt.branch)
      if (!attempts.length) continue
      try {
        if (!hosts.has(task.projectKey)) hosts.set(task.projectKey, await codeHostFor(task.projectKey))
        const host = hosts.get(task.projectKey)
        if (!host) continue
        for (const attempt of attempts) {
          if (!attempt.branch) continue
          const key = `${repoKeyOf(host.repo).toLowerCase()}#${attempt.branch}`
          const interest = interests.get(key) ?? { host, branch: attempt.branch, owners: [] }
          interest.owners.push({ taskId: task.id, sessionId: attempt.sessionId })
          interests.set(key, interest)
        }
      } catch (error) {
        log.warn('pr_branch_discovery_failed', { projectRoot: task.projectKey, error: String(error) })
      }
    }
    return interests
  }

  private async refresh({ host, branch, owners }: BranchInterest): Promise<void> {
    const page = await prIndex.list(host.repo, host.provider, '', { state: 'all', head: branch }, 1)
    const pr = page.items.find((candidate) => candidate.headRef === branch)
    if (!pr) return
    prIndex.pullRequest(host.repo, host.provider, pr.number).seed(pr)
    emitChanged()
    const links = await readTaskPrLinks(getDatabase(), LOCAL_ORGANIZATION_ID)
    const currentSessions = await taskSessions(LOCAL_ORGANIZATION_ID)
    for (const owner of owners) {
      if (!currentSessions[owner.taskId]?.some((attempt) => attempt.sessionId === owner.sessionId
        && attempt.isolatedCheckout && attempt.branch === branch)) continue
      if (links[owner.taskId]?.some((link) => link.number === pr.number
        && link.targetScope === repoKeyOf(host.repo).toLowerCase())) continue
      const task = await Task.byId(LOCAL_ORGANIZATION_ID, owner.taskId)
      if (task.status === 'done' || task.status === 'dropped') continue
      await task.linkPullRequest({
        number: pr.number, url: pr.url, title: pr.title,
        targetScope: repoKeyOf(host.repo), createdBy: 'system', originSessionId: owner.sessionId,
      })
    }
  }
}
