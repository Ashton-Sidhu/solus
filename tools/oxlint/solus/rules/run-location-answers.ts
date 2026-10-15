import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// Where a run works has one owner (docs/plans/run-location.md): readers ask
// `run-location.ts` — `runHost`, `workingPlace`, `projectHome` — and changes go
// through its commands. A reader that opened the value itself is how the
// branch chip once asked one host about a folder on another.
const ownerFile = 'packages/workspace-ui/src/contexts/workspace/run-location.ts'
const parts = new Set(['checkout', 'project'])

const checkedRoots = [
  'packages/workspace-ui/src/',
  'apps/desktop/src/renderer/',
  'apps/client/src/',
]

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function isCheckedFile(path: string): boolean {
  return path !== ownerFile && checkedRoots.some((root) => path.startsWith(root))
}

/** `<anything>.location.checkout` or `<anything>.location.project`. */
function locationPart(node: ESTree.MemberExpression): string | null {
  if (node.computed || node.property.type !== 'Identifier' || !parts.has(node.property.name)) return null
  const owner = node.object
  if (owner.type !== 'MemberExpression' || owner.computed) return null
  if (owner.property.type !== 'Identifier' || owner.property.name !== 'location') return null
  return node.property.name
}

/** Require readers of a run's location to ask its owner module. */
export const runLocationAnswersRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Require reads of a run location to go through run-location.ts answers.',
    },
    messages: {
      reachedIn: 'Do not read location.{{part}} directly. Ask run-location.ts: runHost, checkoutPlace, workingPlace, checkoutGit, projectHome, or pendingClone.',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!isCheckedFile(path)) return {}
    return {
      MemberExpression(node) {
        const part = locationPart(node)
        if (part) context.report({ node, messageId: 'reachedIn', data: { part } })
      },
    }
  },
})
