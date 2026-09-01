import { RuleTester } from 'oxlint/plugins-dev'

import { noPrContextEscapesRule } from './no-pr-context-escapes.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

const componentFile = 'packages/workspace-ui/src/components/pr-review/PrActions.svelte.ts'
const contextFile = 'packages/workspace-ui/src/contexts/prs/pull-request.svelte.ts'
const demoFile = 'apps/client/src/demo/handlers/pr.ts'
const serverFile = 'packages/server/src/server/handlers/provider-handlers.ts'
// One of the two allowlisted holders of search results. `App.svelte` is the
// other; the tester parses TypeScript, so the exemption is asserted here.
const searchIndexFile = 'packages/workspace-ui/src/components/editor/unified-autocomplete/reference-index.svelte.ts'

tester.run('solus/no-pr-context-escapes', noPrContextEscapesRule, {
  valid: [
    // The context is the boundary: it exists to make these calls.
    {
      code: 'const detail = await this.api.prGetDetail(ctx, this.number);',
      filename: contextFile,
    },
    {
      code: 'const result = await this.api.prMerge(ctx, this.number, method, headSha);',
      filename: contextFile,
    },
    {
      code: "const stop = subscribeAllHosts('pr.lifecycleChanged', (serverId, event) => this.apply(event));",
      filename: contextFile,
    },
    // Going through the context is the whole point of the rule.
    {
      code: 'await prs.get(api, serverId, ctx).get(number).merge(method);',
      filename: componentFile,
    },
    {
      code: 'const pr = pullRequests.projects.at(serverId, scope)?.prFor(number);',
      filename: componentFile,
    },
    // The demo answers these calls rather than making them.
    {
      code: "backend.register('prList', () => store.prList());",
      filename: demoFile,
    },
    // The server has no context to route through.
    {
      code: 'const detail = await provider.review.prGetDetail(repo, number);',
      filename: serverFile,
    },
    // Diff content, review targets and worktrees are not pull request facts.
    // They share the prefix and nothing else.
    {
      code: 'const slice = await api.prGetDiff(ctx, request);',
      filename: componentFile,
    },
    {
      code: 'const target = await api.prOpenReview(ctx, number);',
      filename: componentFile,
    },
    {
      code: 'const checkout = await api.prPrepareCheckout(ctx, target);',
      filename: componentFile,
    },
    {
      code: 'await api.prChecksActivity(ctx, true, true);',
      filename: componentFile,
    },
    // Search results are not answers about a pull request: the dropdown that
    // holds them throws them away when it closes.
    {
      code: 'let prCandidates = $state<PullRequest[]>([]);',
      filename: searchIndexFile,
    },
    // A pull request read from the context, not copied into state beside it.
    {
      code: 'const detail = $derived(prs.at(serverId, scope)?.prFor(number) ?? null);',
      filename: componentFile,
    },
  ],
  invalid: [
    // A read that skips the context is a second answer to the same question.
    {
      code: 'const detail = await api.prGetDetail(ctx, number);',
      filename: componentFile,
      errors: [{ messageId: 'factRpc' }],
    },
    {
      code: 'const page = await getApi().prList(ctx, scope, 1);',
      filename: componentFile,
      errors: [{ messageId: 'factRpc' }],
    },
    // The case this rule was written for: the merge that reached the index only
    // if three components in a row passed its result upward.
    {
      code: 'const result = await getApi().prMerge(getCtx(), pr.number, method, pr.headSha);',
      filename: componentFile,
      errors: [{ messageId: 'factRpc' }],
    },
    // Writes that make the mirrored threads and comments wrong.
    {
      code: 'await api.prReplyThread(ctx, number, threadId, body);',
      filename: componentFile,
      errors: [{ messageId: 'factRpc' }],
    },
    {
      code: 'await api.prSubmitReview(ctx, number, review);',
      filename: componentFile,
      errors: [{ messageId: 'factRpc' }],
    },
    {
      code: 'await api.prAddIssueComment(ctx, number, body);',
      filename: componentFile,
      errors: [{ messageId: 'factRpc' }],
    },
    // A copy held outside the index goes stale the moment anything else writes.
    {
      code: 'let detail = $state<PullRequest | null>(null);',
      filename: componentFile,
      errors: [{ messageId: 'localPrState' }],
    },
    {
      code: 'let rows: PullRequest[] = $state([]);',
      filename: componentFile,
      errors: [{ messageId: 'localPrState' }],
    },
    // One subscription, in the store, so two surfaces cannot disagree about
    // what an event meant.
    {
      code: "const stop = subscribeAllHosts('pr.lifecycleChanged', (serverId, event) => { detail = event.detail; });",
      filename: componentFile,
      errors: [{ messageId: 'prEvent' }],
    },
    {
      code: "events.on('pr.checksChanged', (snapshot) => apply(snapshot));",
      filename: componentFile,
      errors: [{ messageId: 'prEvent' }],
    },
  ],
})
