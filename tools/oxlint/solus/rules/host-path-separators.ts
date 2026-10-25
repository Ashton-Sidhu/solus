import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// A host can be a Windows machine, where a path is `C:\code\repo` from Node
// and `C:/code/repo` from git, and a client reads paths from any host. Every
// `'/'` written against a host path broke a feature there: a main checkout
// read as a worktree, an @ mention named the main checkout from a worktree, a
// project label showed its whole path. `@solus/contracts/host-path` answers
// these questions once (docs/plans/windows.md §5.4).
const guardedRoots = [
  'packages/server/src/',
  'packages/contracts/src/',
  'packages/client-core/src/',
  'packages/workspace-ui/src/',
  'apps/desktop/src/',
  'apps/mobile/src/',
  'apps/cli/src/',
]
const exemptFiles = new Set(['packages/contracts/src/host-path.ts'])

/** A name that holds a host path. */
const HOST_PATH_NAME = /(?:path|dir|directory|root|cwd|folder|checkout|worktree)$/i
/** A bare `path` says nothing about whose path it is; in this code it is most often a repo-relative or URL path. */
const UNQUALIFIED_NAMES = new Set(['path'])
/** A path git or a wire format writes with `/` on every host, or no path at all. */
const NOT_HOST_PATH_NAME = /relative|rel(?:Path)?$|repo(?:sitory)?Key|url|href|uri|ref|branch|route|pattern|glob|key$/i

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function nameOf(node: ESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.type === 'ChainExpression') return nameOf(node.expression)
  return null
}

function isHostPath(node: ESTree.Node): boolean {
  const name = nameOf(node)
  return name !== null && !UNQUALIFIED_NAMES.has(name) && HOST_PATH_NAME.test(name) && !NOT_HOST_PATH_NAME.test(name)
}

function isSlash(node: ESTree.Node | undefined): boolean {
  return node?.type === 'Literal' && node.value === '/'
}

/** `x + '/'` or `` `${x}/` ``: a prefix that ends in a separator. */
function slashPrefixOf(node: ESTree.Node | undefined): ESTree.Node | null {
  if (!node) return null
  if (node.type === 'BinaryExpression' && node.operator === '+' && isSlash(node.right)) return node.left
  if (node.type === 'TemplateLiteral' && node.expressions.length === 1 && node.quasis.at(-1)?.value.raw === '/' && node.quasis[0]?.value.raw === '') {
    return node.expressions[0]
  }
  return null
}

/** `/\/+$/` and `/\/$/`: a trailing separator, written for `/` alone. */
function isSlashTrailingPattern(node: ESTree.Node | undefined): boolean {
  if (node?.type !== 'Literal' || !('regex' in node) || !node.regex) return false
  return node.regex.pattern === '\\/+$' || node.regex.pattern === '\\/$'
}

/** Use the shared host-path module for every split, prefix test, and name of a host path. */
export const hostPathSeparatorsRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Ask @solus/contracts/host-path, not a "/", about a host path: it may be a Windows path.',
    },
    messages: {
      separator:
        '"{{name}}" may be a Windows path (`C:\\x` from Node, `C:/x` from git). Use {{use}} from @solus/contracts/host-path.',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!guardedRoots.some((root) => path.startsWith(root)) || exemptFiles.has(path)) return {}
    if (/\.test\.tsx?$/.test(path)) return {}

    const report = (node: ESTree.Node, subject: ESTree.Node, use: string) =>
      context.report({ node, messageId: 'separator', data: { name: nameOf(subject) ?? 'path', use } })

    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier') return
        const method = node.callee.property.name
        const subject = node.callee.object
        const [first] = node.arguments
        if (method === 'split' && isSlash(first) && isHostPath(subject)) report(node, subject, 'hostPathSegments or hostPathBaseName')
        if (method === 'lastIndexOf' && isSlash(first) && isHostPath(subject)) report(node, subject, 'hostPathBaseName')
        if (method === 'startsWith' && isSlash(first) && isHostPath(subject)) report(node, subject, 'isAbsoluteHostPath')
        if (method === 'replace' && isSlashTrailingPattern(first) && isHostPath(subject)) report(node, subject, 'trimTrailingSeparators')
        if (method === 'startsWith') {
          const prefix = slashPrefixOf(first)
          if (prefix && (isHostPath(prefix) || isHostPath(subject))) report(node, isHostPath(prefix) ? prefix : subject, 'isInsideHostPath or relativeHostPath')
        }
      },
    }
  },
})
