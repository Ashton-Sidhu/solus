import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// The server's data folder (`dataDir()`, `solusDir()`) is the server's alone: on a
// managed host it is `solus` 0700, and each member is their own Linux user
// (docs/plans/member-isolation.md §5). A path in it that reaches a member — as text
// in a prompt or a tool result, or in a command the launch point starts — names a
// file the member's agent cannot open. A file handed to an agent belongs in
// `/data/shared`, or in the member's own folders. This rule catches the plain
// cases: the call written where it reaches the member.
const guardedRoot = 'packages/server/src/'

const privateRoots = new Set(['dataDir', 'solusDir'])
const launchCalls = new Set(['launchProcess', 'launchedProcess'])

/** Files that still hand such a path out, each with the change that removes it. None today. */
const knownFiles = new Map<string, string>()

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function calleeName(node: ESTree.CallExpression): string | null {
  if (node.callee.type === 'Identifier') return node.callee.name
  if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier') return node.callee.property.name
  return null
}

/** A template that reads as words, not a path: some fixed part of it holds a space. */
function isText(node: ESTree.TemplateLiteral): boolean {
  return node.quasis.some((quasi) => /\s/.test(quasi.value.cooked ?? quasi.value.raw))
}

/** Where the call reaches a member: `text` inside words, `launch` inside a launch call's arguments. */
function reach(node: ESTree.Node): 'text' | 'launch' | null {
  let current = node
  while (current.parent && current.parent.type !== 'Program') {
    const parent = current.parent
    if (parent.type === 'TemplateLiteral' && isText(parent)) return 'text'
    if (parent.type === 'CallExpression' && parent.callee !== current && launchCalls.has(calleeName(parent) ?? '')) return 'launch'
    if (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') return null
    current = parent
  }
  return null
}

/** Keep the server's private folder out of what a member's agent is told to open. */
export const noPrivatePathToMemberRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Do not hand a path in the server\'s data folder to a member: their agent cannot open it.',
    },
    messages: {
      text: 'This puts a path in the server\'s data folder ({{root}}()) into text an agent reads. On a managed host the member\'s agent cannot open it. Hand the file over from /data/shared or the member\'s own folders (docs/plans/member-isolation.md §5).',
      launch: 'This passes a path in the server\'s data folder ({{root}}()) to a process started for a person. On a managed host it runs as the member, who cannot open it (docs/plans/member-isolation.md §5).',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!path.startsWith(guardedRoot) || knownFiles.has(path)) return {}
    return {
      CallExpression(node) {
        const root = calleeName(node)
        if (!root || node.callee.type !== 'Identifier' || !privateRoots.has(root)) return
        const where = reach(node)
        if (where) context.report({ node, messageId: where, data: { root } })
      },
    }
  },
})
