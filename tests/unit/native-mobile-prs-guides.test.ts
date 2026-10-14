import { describe, expect, test } from 'bun:test'
import type { ReviewGuide, ReviewGuideStatusEvent } from '@solus/contracts/review'
import { PullRequestGuides } from '../../apps/mobile/src/features/prs/pull-request-guides'
import { guideNotice, prGuideKey, prGuideStatus, prGuideTarget, reviewGuideState } from '../../apps/mobile/src/features/prs/lib/pull-request-guide-state'
import { shownValue, type LoadState } from '../../apps/mobile/src/features/prs/pull-request-reads'
import type { PullRequestGuide } from '../../apps/mobile/src/features/prs/lib/pull-request-guide-state'
import { FakeApi, flushPromises } from './helpers/native-mobile-fakes'
import { hostWorld, PR_REF, pullRequest } from './helpers/native-mobile-prs-fixtures'

// The guide of a pull request behaves as on the web: the host's saved status
// names it, a guide for an older head is outdated but still readable, and a
// running job is followed by host events while the pull request is shown.

const pr = pullRequest(7, { headSha: 'head-new' })
const target = prGuideTarget(pr)
const status = (overrides: Partial<ReviewGuideStatusEvent> = {}): ReviewGuideStatusEvent => ({
  repoRoot: '/work/app', key: prGuideKey(target), scope: 'pr', target, status: 'ready', headSha: 'head-new', updatedAt: 1, ...overrides,
})
const guide = (headSha: string): ReviewGuide => ({ version: 1, key: prGuideKey(target), headSha, baseSha: 'base', title: 'Guide', summary: '', sections: [] })
const loaded = (value: PullRequestGuide): LoadState<PullRequestGuide> => ({ kind: 'loaded', value })
const notice = (state: LoadState<PullRequestGuide>, extra: { starting?: boolean; startError?: string | null } = {}) =>
  guideNotice({ state, pr, starting: extra.starting ?? false, startError: extra.startError ?? null }).kind

describe('guide state (ported from T3 reviewGuideState.test.ts)', () => {
  test('the target names the pull request in its base repository and its shown revision', () => {
    expect(target).toEqual({ kind: 'pr', host: 'github.com', owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/pull/7', baseSha: 'base', headSha: 'head-new' })
  })

  test('a ready guide for another head is outdated', () => {
    expect(prGuideStatus(status({ headSha: 'head-old' }), pr)).toBe('outdated')
    expect(prGuideStatus(status(), pr)).toBe('ready')
    expect(prGuideStatus(status({ status: 'generating', headSha: 'head-old' }), pr)).toBe('generating')
    expect(prGuideStatus(null, pr)).toBeNull()
  })

  test('keeps a previous guide readable during a rewrite, and shows only failures for the current head', () => {
    expect(reviewGuideState({ guide: guide('head-old'), status: status({ status: 'generating' }) }, pr)).toMatchObject({ stale: true, running: true, failure: null })
    expect(reviewGuideState({ guide: null, status: status({ status: 'failed', error: 'Writer stopped.' }) }, pr).failure).toBe('Writer stopped.')
    expect(reviewGuideState({ guide: null, status: status({ status: 'failed', headSha: 'head-old', error: 'x' }) }, pr).failure).toBeNull()
  })

  test('notice transitions: loading, empty, writing, failed, stale, ready, unavailable', () => {
    expect(notice({ kind: 'loading', previous: null })).toBe('loading')
    expect(notice(loaded({ status: null, guide: null }))).toBe('empty')
    expect(notice({ kind: 'loading', previous: { status: status(), guide: guide('head-new') } })).toBe('ready')
    const failed = loaded({ status: status({ status: 'failed', error: 'x' }), guide: null })
    expect(notice(failed)).toBe('failed')
    expect(notice(failed, { starting: true })).toBe('writing')
    const stale = loaded({ status: status({ headSha: 'head-old' }), guide: guide('head-old') })
    expect(notice(stale)).toBe('stale')
    expect(notice({ kind: 'error', message: 'Connection lost', githubAuth: false, offline: true, previous: null })).toBe('unavailable')
    expect(notice(loaded({ status: null, guide: null }), { startError: 'No agent' })).toBe('failed')
    const gitFailure = 'Command failed: git fetch origin abc\nfatal: remote error: upload-pack: not our ref abc'
    const shown = guideNotice({ state: loaded({ status: status({ status: 'failed', error: gitFailure }), guide: null }), pr, starting: false, startError: null })
    expect(shown.description).toContain('Refresh the pull request')
    expect(shown.details).toBe(gitFailure)
  })
})

describe('pull request guides store', () => {
  test('reads the saved guide when the host has one, with the pull request target', async () => {
    const api = new FakeApi()
      .on('prGuideStatuses', () => [status({ headSha: 'head-old' })])
      .on('readGuide', () => guide('head-old'))
    const world = await hostWorld(api, { connected: true })
    const guides = new PullRequestGuides((hostId) => world.connections.connection(hostId), () => null)
    await guides.load(PR_REF, pr)
    expect(api.callsOf('prGuideStatuses')[0]![1]).toEqual([{ target }])
    expect(api.callsOf('readGuide')[0]!.slice(1)).toEqual([prGuideKey(target), target])
    const value = shownValue(guides.guideOf(PR_REF))
    expect(value?.guide?.headSha).toBe('head-old')
    expect(prGuideStatus(value!.status, pr)).toBe('outdated')
  })

  test('no saved guide reads no guide', async () => {
    const api = new FakeApi().on('prGuideStatuses', () => [null])
    const world = await hostWorld(api, { connected: true })
    const guides = new PullRequestGuides((hostId) => world.connections.connection(hostId), () => null)
    await guides.load(PR_REF, pr)
    expect(shownValue(guides.guideOf(PR_REF))).toEqual({ status: null, guide: null })
    expect(api.callsOf('readGuide')).toHaveLength(0)
  })

  test('a request queues the job, events follow it, and a ready event reads the new guide', async () => {
    let saved: ReviewGuideStatusEvent | null = null
    const api = new FakeApi()
      .on('prGuideStatuses', () => [saved])
      .on('requestReviewGuide', () => status({ status: 'queued', updatedAt: 2 }))
      .on('readGuide', () => guide('head-new'))
    const world = await hostWorld(api, { connected: true })
    const guides = new PullRequestGuides((hostId) => world.connections.connection(hostId), () => null)
    await guides.load(PR_REF, pr)
    const stop = guides.watch(PR_REF, pr)
    await guides.request(PR_REF, pr)
    expect(api.callsOf('requestReviewGuide')[0]![1]).toEqual({ target })
    expect(shownValue(guides.guideOf(PR_REF))?.status?.status).toBe('queued')
    // An older event does not move the job back.
    world.transports[0]!.emit('review.guideStatusChanged', status({ status: 'generating', updatedAt: 1 }))
    expect(shownValue(guides.guideOf(PR_REF))?.status?.status).toBe('queued')
    saved = status({ updatedAt: 3, generatedAt: 'now' })
    world.transports[0]!.emit('review.guideStatusChanged', saved)
    await flushPromises()
    await flushPromises()
    expect(shownValue(guides.guideOf(PR_REF))?.guide?.headSha).toBe('head-new')
    // Another pull request's event is not this one's.
    world.transports[0]!.emit('review.guideStatusChanged', status({ target: { ...target, number: 8 }, status: 'failed', updatedAt: 9 }))
    expect(shownValue(guides.guideOf(PR_REF))?.status?.status).toBe('ready')
    stop()
    world.transports[0]!.emit('review.guideStatusChanged', status({ status: 'queued', updatedAt: 10 }))
    expect(shownValue(guides.guideOf(PR_REF))?.status?.status).toBe('ready')
  })

  test('a request without a connection is kept as the start error', async () => {
    const api = new FakeApi()
    const world = await hostWorld(api)
    const guides = new PullRequestGuides((hostId) => world.connections.connection(hostId), () => null)
    await guides.request(PR_REF, pr)
    expect(guides.startErrorOf(PR_REF)).toBe('Connect to this host to make this change.')
    expect(guides.isStarting(PR_REF)).toBe(false)
    expect(api.callsOf('requestReviewGuide')).toHaveLength(0)
  })
})
