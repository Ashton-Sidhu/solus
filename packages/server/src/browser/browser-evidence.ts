import {
  snapshotViewportLabel,
  type BrowserCaptureRequest,
  type BrowserEvidence,
  type BrowserEvidenceOptions,
  type BrowserEvidenceTarget,
  type BrowserPage,
} from '@solus/contracts/browser-types'
import { resolveRepoRef } from '../git/git-helpers'
import { getExistingPR } from '../git/worktree-manager'
import { createLogger } from '../logger'
import { providerForRepo } from '../providers/registry'
import { writeAssetUpload } from '../server/assets'
import { storedAssetPath } from '../server/asset-paths'
import { Task } from '../tasks/task'
import { browserRegistry } from './browser-registry'
import { pullRequestNumber } from './pull-request-link'

/**
 * The evidence loop: a capture that outlives the turn that took it.
 *
 * A screenshot the agent looked at and nobody else can see is half a check.
 * Everything here turns a browser page into a durable, shared artefact — an
 * asset the conversation renders, a comment on the task the work belongs to, or
 * an image in the pull request a human will actually read.
 *
 * The asset store is the single source of truth. Attaching to a task is
 * immediate and local, because Solus renders `asset://` itself. Publishing
 * outside Solus happens only for a pull request, and only then, because that is
 * the one destination that cannot read a local asset.
 */

const log = createLogger('browser', 'browser-evidence.ts')

/** Take the page's picture, store it, and file it where the caller asked. */
export async function captureEvidence(request: BrowserCaptureRequest): Promise<BrowserEvidence> {
  const { screenshot, page } = await browserRegistry().capture(request.browserPageId)
  const stored = await writeAssetUpload({
    name: `browser-${request.browserPageId}.png`,
    mime: 'image/png',
    dataUrl: screenshot,
  })
  const evidence: BrowserEvidence = {
    browserPageId: request.browserPageId,
    assetId: stored.id,
    hostPath: storedAssetPath(stored.id),
    attachedTo: 'the asset store',
    url: page.url,
    viewport: snapshotViewportLabel(page.viewport),
    capturedAt: Date.now(),
  }
  if (!request.attach) return evidence

  const attached = await attachEvidence(stored.id, request.attach, {
    page,
    caption: request.caption,
  })
  evidence.attachedTo = attached.attachedTo
  if (attached.publishedUrl) evidence.publishedUrl = attached.publishedUrl
  log.info('browser_evidence_attached', {
    browserPageId: request.browserPageId,
    assetId: stored.id,
    target: request.attach.kind,
  })
  return evidence
}

interface EvidenceContext {
  page: BrowserPage
  caption?: string | undefined
}

/**
 * File an already-stored capture.
 *
 * Separate from taking it so an agent's `browser_snapshot` — which has already
 * paid for the picture and written the asset — attaches the same bytes rather
 * than capturing the page a second time and filing a different moment.
 */
export async function attachEvidence(
  assetId: string,
  target: BrowserEvidenceTarget,
  context: EvidenceContext,
): Promise<{ attachedTo: string; publishedUrl?: string }> {
  const caption = context.caption?.trim() || describeCapture(context.page)

  if (target.kind === 'task') {
    const task = await Task.byId(target.taskId)
    // A local asset URI, on purpose: Solus renders it inline, and the task
    // domain already refuses to push a body containing one to an upstream
    // ticket, where the link would resolve to nothing.
    await task.comment(`![${caption}](asset://${assetId})\n\n${caption}`)
    return { attachedTo: `task ${target.taskId}` }
  }

  const repo = await resolveRepoRef(target.cwd)
  if (!repo) throw new Error('This checkout has no recognized git remote to attach evidence to.')
  const provider = providerForRepo(repo)
  if (!provider) throw new Error(`Unsupported git host ${repo.host}.`)
  const auth = await provider.auth.status()
  if (!auth.connected) {
    throw new Error('GitHub is not connected — connect it in Settings → Connections.')
  }

  // The bytes go to the host's own attachment endpoint — the one its web
  // composer and `gh --attach` use — so evidence lands as a real attachment
  // rather than as a file committed into the repository.
  const publishedUrl = await provider.review.publishAsset(repo, assetId)
  await provider.review.addIssueComment(repo, target.number, `![${caption}](${publishedUrl})\n\n${caption}`)
  return { attachedTo: `pull request #${target.number}`, publishedUrl }
}

/** What the capture is of, in one line: the reader of a pull request has no
 *  other way to know which viewport they are looking at. */
function describeCapture(page: BrowserPage): string {
  return `${page.title || page.url} — ${snapshotViewportLabel(page.viewport)}`
}

/**
 * What this page's capture could be filed against.
 *
 * The pull request is looked up from the branch the page's worktree is on,
 * which is the only mapping that holds without a new index: the scanner already
 * attributes a dev server to a worktree, and a worktree is on exactly one
 * branch. A page with no worktree — a hand-typed URL, a remote site — has
 * nothing to offer, and says so by returning empty.
 */
export async function evidenceOptions(browserPageId: string): Promise<BrowserEvidenceOptions> {
  const page = browserRegistry().get(browserPageId)
  if (!page || page.target.kind !== 'url') return {}
  const { worktreePath, branch } = page.target
  const options: BrowserEvidenceOptions = {}
  if (worktreePath) options.worktreePath = worktreePath
  if (branch) options.branch = branch
  if (!worktreePath || !branch) return options

  const url = await getExistingPR(branch, worktreePath).catch(() => null)
  const number = url ? pullRequestNumber(url) : null
  if (url && number) options.pullRequest = { number, url }
  return options
}
