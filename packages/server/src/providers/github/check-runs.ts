import type { CheckLogResult, CheckRerunResult } from '../types'
import { FAILURE_CONCLUSIONS } from '../check-selection'
import type { RepoRef } from '@solus/contracts/providers'
import type { CheckItem } from '@solus/contracts/checks-types'
import { z } from 'zod'
import { isGithubCredentialAccessFailure, type GitHubClient } from './octokit'
import { githubRateLimitOf } from './rate-limit'

const NO_JOB = 'This check is not a GitHub Actions job in this repository at the current PR head.'
const MAX_LOG_BYTES = 16 * 1024 * 1024
const MAX_LOG_CHARS = 32_000

export function actionsJobId(repo: RepoRef, check: CheckItem): number | null {
  if (!check.detailsUrl || check.appName !== 'GitHub Actions') return null
  const url = URL.parse(check.detailsUrl)
  if (!url || url.protocol !== 'https:' || url.host.toLowerCase() !== repo.host.toLowerCase()) return null
  const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/jobs?\/(\d+)$/.exec(url.pathname)
  if (!match) return null
  const [, owner, name, jobId] = match
  if (owner.toLowerCase() !== repo.owner.toLowerCase() || name.toLowerCase() !== repo.repo.toLowerCase()) return null
  const id = Number(jobId)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function jobAtHead(client: GitHubClient, repo: RepoRef, check: CheckItem, headSha: string) {
  const id = actionsJobId(repo, check)
  if (id === null) return null
  const { data } = await client.rest.actions.getJobForWorkflowRun({ owner: repo.owner, repo: repo.repo, job_id: id })
  const checkRunId = URL.parse(data.check_run_url)?.pathname.split('/').at(-1)
  const matches = data.head_sha ? data.head_sha === headSha : checkRunId === check.id
  return matches ? { id, runId: data.run_id } : null
}

const httpStatus = z.object({ status: z.number() })

/** Auth/rate errors reach the shared credential policy rather than looking like an absent log. */
export function isCheckAccessFailure(error: Parameters<typeof githubRateLimitOf>[0]): boolean {
  const status = httpStatus.safeParse(error)
  return !!githubRateLimitOf(error) || (isGithubCredentialAccessFailure(error) && status.data?.status !== 404)
}

async function annotationsForLog(client: GitHubClient, repo: RepoRef, checkRunId: number, fallback: string): Promise<string> {
  const target = { owner: repo.owner, repo: repo.repo, check_run_id: checkRunId }
  try {
    const [run, annotations] = await Promise.all([
      client.rest.checks.get(target),
      client.rest.checks.listAnnotations({ ...target, per_page: 50 }),
    ])
    return [
      `GitHub returned no log for this job${run.data.conclusion ? `; it concluded ${run.data.conclusion}` : ''}.`,
      run.data.output.title, run.data.output.summary,
      ...annotations.data.map(annotation => `${annotation.annotation_level}: ${annotation.message}`),
    ].filter(Boolean).join('\n').slice(0, MAX_LOG_CHARS)
  } catch (error) {
    if (isCheckAccessFailure(error)) throw error
    return fallback
  }
}

export async function readActionsCheckLog(
  client: GitHubClient, repo: RepoRef, check: CheckItem, _headSha: string, tailLines: number,
): Promise<CheckLogResult> {
  const result = { name: check.name, url: check.detailsUrl, log: null, truncated: false }
  const id = actionsJobId(repo, check)
  if (id === null) return { ...result, detail: NO_JOB }
  const response = await client.rest.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
    owner: repo.owner, repo: repo.repo, job_id: id,
    request: { parseSuccessResponseBody: false, signal: AbortSignal.timeout(60_000) },
  }).catch(async (error) => {
    if (isCheckAccessFailure(error)) throw error
    const detail = error instanceof Error ? error.message : String(error)
    // The check-run id from the PR rollup is authoritative, including for a job that never started.
    const runId = /^\d+$/.test(check.id) ? Number(check.id) : id
    return { fallback: await annotationsForLog(client, repo, runId, detail) }
  })
  if ('fallback' in response) return { ...result, detail: response.fallback }
  const body = z.instanceof(ReadableStream).parse(response.data)
  const reader = body.getReader()
  let contents = ''
  let limited = false
  const decoder = new TextDecoder()
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) throw new Error('GitHub returned an invalid log stream.')
      contents += decoder.decode(value.subarray(0, MAX_LOG_BYTES - bytes), { stream: true })
      bytes += value.length
      if (bytes >= MAX_LOG_BYTES) {
        limited = true
        await reader.cancel()
        break
      }
    }
    contents += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  const lines = contents.slice(0, MAX_LOG_BYTES).replace(/\n$/, '').split('\n')
  const log = lines.slice(-tailLines).join('\n')
  return {
    ...result,
    log: log.slice(-MAX_LOG_CHARS),
    truncated: limited || lines.length > tailLines || log.length > MAX_LOG_CHARS,
    detail: limited ? 'The log exceeded the download limit. These lines are from the portion downloaded.' : null,
  }
}

export async function rerunActionsChecks(
  client: GitHubClient, repo: RepoRef, checks: CheckItem[], headSha: string,
): Promise<CheckRerunResult[]> {
  const results: CheckRerunResult[] = checks.map((check) => ({ name: check.name, rerun: false, detail: NO_JOB }))
  const byRun = new Map<number, RerunJob[]>()
  const repository = { owner: repo.owner, repo: repo.repo }
  for (let offset = 0; offset < checks.length; offset += 4) {
    const jobs = await Promise.all(checks.slice(offset, offset + 4).map((check, index) =>
      jobAtHead(client, repo, check, headSha).catch((error) => {
        if (isCheckAccessFailure(error)) throw error
        results[offset + index].detail = error instanceof Error ? error.message : String(error)
        return null
      })))
    for (const [index, job] of jobs.entries()) {
      if (!job) continue
      const entries = byRun.get(job.runId) ?? []
      entries.push({ id: job.id, result: results[offset + index] })
      byRun.set(job.runId, entries)
    }
  }
  const groups = [...byRun]
  for (let offset = 0; offset < groups.length; offset += 2) {
    await Promise.all(groups.slice(offset, offset + 2).map(([runId, jobs]) => rerunGroup(client, repository, runId, jobs)))
  }
  return results
}

interface RerunJob {
  id: number
  result: CheckRerunResult
}

async function rerunGroup(client: GitHubClient, repo: Pick<RepoRef, 'owner' | 'repo'>, runId: number, jobs: RerunJob[]) {
  let selected = jobs
  try {
    if (jobs.length > 1 && await allFailedJobsSelected(client, repo, runId, jobs)) {
      await client.rest.actions.reRunWorkflowFailedJobs({ ...repo, run_id: runId })
    } else {
      selected = jobs.filter(job => job.id === jobs[0].id)
      for (const job of jobs) {
        if (job.id !== jobs[0].id) job.result.detail = 'GitHub accepts one job rerun at a time for this workflow.'
      }
      await client.rest.actions.reRunJobForWorkflowRun({ ...repo, job_id: jobs[0].id })
    }
    for (const job of selected) Object.assign(job.result, { rerun: true, detail: null })
  } catch (error) {
    for (const job of selected) job.result.detail = error instanceof Error ? error.message : String(error)
  }
}

async function allFailedJobsSelected(
  client: GitHubClient, repo: Pick<RepoRef, 'owner' | 'repo'>, runId: number, jobs: RerunJob[],
): Promise<boolean> {
  const page = await client.rest.actions.listJobsForWorkflowRun({ ...repo, run_id: runId, filter: 'latest', per_page: 100 })
    .catch((error) => {
      if (isCheckAccessFailure(error)) throw error
      return null
    })
  if (!page || page.data.total_count > page.data.jobs.length) return false
  const failed = page.data.jobs.filter((job) => FAILURE_CONCLUSIONS.has(job.conclusion ?? ''))
  const selectedIds = new Set(jobs.map((job) => job.id))
  return failed.length === selectedIds.size && failed.every((job) => selectedIds.has(job.id))
}
