import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// What a client knows about a pull request lives in one place: the pull request
// context. It holds an entity per pull request per project, and every response
// that describes one is filed there, so what one surface writes is what every
// other surface reads.
//
// A call that skips it produces a second answer to the same question. That is
// not hypothetical — a merge used to be posted straight from the merge button,
// and the pull request it returned reached the index only if three components
// in a row remembered to hand it upward. Miss a hop and one surface draws the
// pull request open while another draws it merged.
//
// So: inside the client, a call that reads or changes a pull request fact goes
// through the context, and a pull request is held there rather than copied out.
const prContextRoot = 'packages/workspace-ui/src/contexts/prs/'

// The client, where a second copy of a pull request can disagree with the
// index. The server has no context to route through.
const checkedRoots = [
  'packages/workspace-ui/src/',
  'apps/desktop/src/renderer/',
  'apps/client/src/',
]

// The demo answers these calls rather than making them: it is a stand-in host,
// so it is on the far side of this boundary in the same way a preload bridge is.
const hostSideRoots = ['apps/client/src/demo/']

/**
 * The calls whose argument or result is a pull request fact.
 *
 * Membership is decided by what a call touches, not by whether it reads or
 * writes. `prMerge` takes the head this client last saw and returns what the
 * pull request became, so it belongs here as much as `prGetDetail` does.
 */
const prFactRpcs = new Set([
  // Reads the index files.
  'prList',
  'prNeedsReview',
  'prGetOverview',
  'prGetDetail',
  'prGetEfforts',
  'prChangedFiles',
  'prListCommits',
  'prListComments',
  'prListThreads',
  'prListReviewers',
  'prListReviewerCandidates',
  'prInterdiff',
  'prChecks',
  'prGuideMetadata',
  // Writes that change what the index holds, or make it wrong.
  'prUpdate',
  'prUpdateLifecycle',
  'prMerge',
  'prRequestReviewers',
  'prRemoveRequestedReviewer',
  'prReplyThread',
  'prResolveThread',
  'prUnresolveThread',
  'prAddIssueComment',
  'prDeleteIssueComment',
  'prSubmitReview',
  'prGenerateGuides',
  'prInvalidate',
])

// Deliberately absent from the set above, because none of them touches a pull
// request fact: `prGetDiff`, `prGetDiffFileContents` and `prOpenReview` return
// diff content and a review target, `prPrepareCheckout` and
// `prPrepareConflictResolution` return a worktree, and `prChecksActivity` is a
// poll-cadence hint. They share the `pr` prefix and nothing else.

/** The type that describes a pull request. There is exactly one, named once:
 *  a client entity and a server entity both hold a `PullRequest` and neither
 *  renames it on the way in. */
const prRecordTypes = new Set(['PullRequest'])

/**
 * Files that may hold pull requests in local state.
 *
 * Both hold search results — what the user typed matched, ranked for one
 * dropdown and thrown away when it closes. They are not answers about a pull
 * request, so nothing reads them expecting the pull request's current state.
 */
const searchResultFiles = new Set([
  'packages/workspace-ui/src/App.svelte',
  'packages/workspace-ui/src/components/editor/unified-autocomplete/reference-index.svelte.ts',
])

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function isCheckedFile(path: string): boolean {
  if (path.startsWith(prContextRoot)) return false
  if (hostSideRoots.some((root) => path.startsWith(root))) return false
  return checkedRoots.some((root) => path.startsWith(root))
}

/**
 * True when a type annotation names a pull request, including
 * `PullRequest | null` and `PullRequest[]`.
 *
 * The recursion follows named type keys rather than every property: AST nodes
 * carry a `parent` back-reference, so a generic walk cycles forever.
 */
function namesPrFactType(node: ESTree.Node | null | undefined): boolean {
  if (!node) return false
  switch (node.type) {
    case 'TSTypeReference':
      if (node.typeName.type === 'Identifier' && prRecordTypes.has(node.typeName.name)) return true
      return (node.typeArguments?.params ?? []).some(namesPrFactType)
    case 'TSUnionType':
    case 'TSIntersectionType':
      return node.types.some(namesPrFactType)
    case 'TSArrayType':
      return namesPrFactType(node.elementType)
    default:
      return false
  }
}

/** `$state<PullRequest[]>([])` — a pull request kept beside the index. */
function isPrRuneState(node: ESTree.CallExpression): boolean {
  if (node.callee.type !== 'Identifier') return false
  if (node.callee.name !== '$state' && node.callee.name !== '$derived') return false
  return (node.typeArguments?.params ?? []).some(namesPrFactType)
}

/** The topic a subscription is for, when it is named by a literal. */
function subscribedTopic(node: ESTree.CallExpression): string | null {
  const [topic] = node.arguments
  if (!topic || topic.type !== 'Literal' || typeof topic.value !== 'string') return null
  return topic.value.startsWith('pr.') ? topic.value : null
}

/** Keep every pull request fact in the client behind the pull request context. */
export const noPrContextEscapesRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Read and change pull requests through the pull request context, so every surface shows one answer.',
    },
    messages: {
      factRpc:
        'Do not call {{name}} here. Get the pull request from the context — prsStore.get(api, serverId, ctx).get(number) — and call it there, so what this returns reaches the index every surface reads.',
      localPrState:
        'Do not hold a pull request in local state. Read it from the pull request context, so a change landing on another surface reaches this one.',
      prEvent:
        'Do not subscribe to {{topic}} here. The pull request context holds the one subscription and applies the event to its index.',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!isCheckedFile(path)) return {}
    const mayHoldSearchResults = searchResultFiles.has(path)

    return {
      CallExpression(node) {
        const topic = subscribedTopic(node)
        if (topic) {
          context.report({ node, messageId: 'prEvent', data: { topic } })
          return
        }

        if (!mayHoldSearchResults && isPrRuneState(node)) {
          context.report({ node, messageId: 'localPrState' })
          return
        }

        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.computed) return
        if (callee.property.type !== 'Identifier') return
        if (!prFactRpcs.has(callee.property.name)) return
        context.report({ node, messageId: 'factRpc', data: { name: callee.property.name } })
      },

      // A declared holder is as much a second copy as an assigned one.
      VariableDeclarator(node) {
        if (mayHoldSearchResults) return
        if (!node.init || node.init.type !== 'CallExpression') return
        if (node.init.callee.type !== 'Identifier' || node.init.callee.name !== '$state') return
        if (!namesPrFactType(node.id.typeAnnotation?.typeAnnotation)) return
        context.report({ node, messageId: 'localPrState' })
      },
    }
  },
})
