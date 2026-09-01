import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// A working directory reaches the server from a client, and the renderer uses
// `'~'` as its sentinel for "no directory known yet". `spawn` reads that as a
// literal directory name and fails with ENOENT, which the Claude SDK reports as
// "the native binary exists but failed to launch" — naming the executable for a
// fault in its working directory. The agents are where Solus launches
// processes, so every `cwd` they hand out is resolved first.
const guardedRoot = 'packages/server/src/agents/'

const resolverName = 'resolveHomePath'

/** Calls that already answer with a real path, so re-resolving proves nothing. */
const trustedCalls = new Set([resolverName, 'homedir', 'tmpdir', 'join', 'resolve'])

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function calleeName(node: ESTree.Node): string | null {
  if (node.type !== 'CallExpression') return null
  if (node.callee.type === 'Identifier') return node.callee.name
  if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier') {
    return node.callee.property.name
  }
  return null
}

/** `log.info('event', { … })` and friends — the payload is a record of what
 *  happened, not an argument to anything. */
function isLogCall(node: ESTree.Node): boolean {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false
  const { object, property } = node.callee
  if (property.type !== 'Identifier') return false
  if (!['info', 'warn', 'error', 'debug', 'trace'].includes(property.name)) return false
  return object.type === 'Identifier' && /^_?log$/.test(object.name)
}

/** A zod schema declares the shape of a `cwd`; it never becomes one. */
function isSchema(node: ESTree.Node): boolean {
  let current: ESTree.Node = node
  for (;;) {
    if (current.type === 'CallExpression') { current = current.callee; continue }
    if (current.type === 'MemberExpression') { current = current.object; continue }
    return current.type === 'Identifier' && current.name === 'z'
  }
}

/** A value that cannot carry an unexpanded `~` through to a process. */
function isResolved(value: ESTree.Node): boolean {
  if (value.type === 'Literal') return true
  if (value.type === 'TemplateLiteral') return true
  if (isSchema(value)) return true
  const called = calleeName(value)
  return called !== null && trustedCalls.has(called)
}

/** Resolve every working directory the agents hand to a process. */
export const requireResolvedCwdRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Pass agent working directories through resolveHomePath so an unexpanded "~" never reaches spawn.',
    },
    messages: {
      unresolvedCwd:
        'Wrap this cwd in {{resolver}}(). The renderer sends "~" when no directory is known yet, and spawn reads it as a literal directory — the ENOENT surfaces as "the native binary exists but failed to launch".',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!path.startsWith(guardedRoot)) return {}

    // A log entry must show the path as it arrived — resolving it there would
    // erase the very `~` this rule exists to catch. Ancestors are visited
    // before their descendants, so a payload is always recorded before the
    // properties inside it are checked.
    const logPayloads: Array<[number, number]> = []
    // Locals declared from a resolved expression, so `{ cwd }` shorthand passes
    // where `const cwd = resolveHomePath(...)` did the work. Names are matched
    // file-wide rather than per scope: a file that resolves a name once and
    // shadows it unresolved elsewhere would slip through, which is why the
    // resolver is also applied at the SDK call itself.
    const resolvedLocals = new Set<string>()

    return {
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || !node.init) return
        if (isResolved(node.init)) resolvedLocals.add(node.id.name)
      },
      CallExpression(node) {
        if (calleeName(node) === null || !isLogCall(node)) return
        for (const argument of node.arguments) {
          if (argument.type === 'ObjectExpression') logPayloads.push([argument.start, argument.end])
        }
      },
      Property(node) {
        if (logPayloads.some(([start, end]) => node.start >= start && node.end <= end)) return
        if (node.computed || node.key.type !== 'Identifier' || node.key.name !== 'cwd') return
        // Type members and destructuring patterns declare a shape; only a value
        // can reach a process.
        if (node.value.type === 'AssignmentPattern' || node.value.type === 'ObjectPattern') return
        if (node.shorthand && node.value.type === 'Identifier' && resolvedLocals.has(node.value.name)) return
        if (isResolved(node.value)) return
        context.report({
          node: node.value,
          messageId: 'unresolvedCwd',
          data: { resolver: resolverName },
        })
      },
    }
  },
})
