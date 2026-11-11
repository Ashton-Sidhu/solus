import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// GitHub and Jira own every task (docs/plans/provider-owned-tasks.md). A write
// that skips the provider adapter skips what the adapter does on the way out:
// asset publishing, comment-id normalization, the read-after-write rule. That
// is how a pasted screenshot once reached GitHub as a literal `asset://`
// reference that only the origin host could resolve.
//
// So: inside the task layer, a task write goes through a task adapter
// (`taskAdapters().provider(...)` or `.source(...)`).
const taskLayerRoot = 'packages/server/src/data/tasks/'

// The adapters are the boundary and may talk to GitHub however they need to.
const boundaryModules = [
  'packages/server/src/data/tasks/providers/',
  'packages/server/src/data/tasks/sources/',
]

/** Writes that put something on a ticket. Reads are free: they cannot diverge. */
const ticketWrites = new Set([
  'publishAssets',
])

/** REST namespaces that write to an issue, for a call that skips the provider. */
const issueRestWrites = new Set([
  'create',
  'update',
  'createComment',
  'updateComment',
  'deleteComment',
  'addLabels',
  'removeLabel',
  'setLabels',
  'lock',
  'unlock',
])

// How a task adapter is obtained (`taskAdapters().provider(id)`). Anything else
// holding a task write is assumed to be a raw client, which is the case worth reporting.
const adapterFactories = new Set(['provider', 'source'])

const adapterTypeNames = new Set(['TaskProviderAdapter', 'TaskSourceAdapter'])

// A field that holds one, so `target.adapter.createTicket(...)` reads as the
// adapter call it is.
const adapterProperties = new Set(['adapter'])

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function isBoundaryModule(path: string): boolean {
  return boundaryModules.some((module) => path.startsWith(module))
}

/** The callee name, whether it is called plainly or as a member. */
function calleeName(node: ESTree.Expression): string | null {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name
  }
  return null
}

/** See through `await`, `!`, and `as` to the expression that produced the value. */
function unwrap(node: ESTree.Expression): ESTree.Expression {
  if (node.type === 'AwaitExpression') return unwrap(node.argument)
  if (node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression') return unwrap(node.expression)
  return node
}

/**
 * True when a type annotation names the adapter contract, including
 * `TaskSyncAdapter | null` and `Promise<TaskSyncAdapter>`.
 *
 * The recursion follows named type keys rather than every property: AST nodes
 * carry a `parent` back-reference, so a generic walk cycles until the stack
 * runs out.
 */
function namesAdapterType(node: ESTree.Node | null | undefined): boolean {
  if (!node) return false
  switch (node.type) {
    case 'TSTypeAnnotation':
      return namesAdapterType(node.typeAnnotation)
    case 'TSTypeReference':
      if (node.typeName.type === 'Identifier' && adapterTypeNames.has(node.typeName.name)) return true
      return (node.typeArguments?.params ?? []).some(namesAdapterType)
    case 'TSUnionType':
    case 'TSIntersectionType':
      return node.types.some(namesAdapterType)
    case 'TSArrayType':
      return namesAdapterType(node.elementType)
    default:
      return false
  }
}

/** Keep every task write in the task layer behind a task adapter. */
export const noGithubTaskEscapesRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Write to a GitHub or Jira task through a task adapter, so each write takes one path.',
    },
    messages: {
      providerWrite:
        'Do not call {{name}} on a raw client. Bind a task adapter from taskAdapters().provider(...) and call it there, so asset publishing and comment normalization happen on every path.',
      restWrite:
        'Do not call rest.issues.{{name}} outside the task adapters. A task write belongs behind the adapter boundary.',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!path.startsWith(taskLayerRoot) || isBoundaryModule(path)) return {}

    // Names known to hold an adapter. Everything else that performs a ticket
    // write is treated as a provider reached around the boundary.
    const adapterBindings = new Set<string>()

    const declareIfAdapter = (name: ESTree.Node, annotated: boolean, init?: ESTree.Expression | null) => {
      if (name.type !== 'Identifier') return
      if (annotated) {
        adapterBindings.add(name.name)
        return
      }
      if (!init) return
      const value = unwrap(init)
      if (value.type !== 'CallExpression') return
      const factory = calleeName(value.callee as ESTree.Expression)
      if (factory && adapterFactories.has(factory)) adapterBindings.add(name.name)
    }

    return {
      VariableDeclarator(node) {
        declareIfAdapter(node.id, namesAdapterType(node.id.typeAnnotation), node.init)
      },
      // A function handed an adapter is as trusted as one that resolved its own.
      Identifier(node) {
        if (namesAdapterType(node.typeAnnotation)) adapterBindings.add(node.name)
      },
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.computed) return
        if (callee.property.type !== 'Identifier') return
        const name = callee.property.name

        if (issueRestWrites.has(name)
          && callee.object.type === 'MemberExpression'
          && !callee.object.computed
          && callee.object.property.type === 'Identifier'
          && callee.object.property.name === 'issues') {
          context.report({ node, messageId: 'restWrite', data: { name } })
          return
        }

        if (!ticketWrites.has(name)) return
        const receiver = callee.object
        // `this.pushFields(...)` is an adapter calling itself.
        if (receiver.type === 'ThisExpression') return
        if (receiver.type === 'Identifier' && adapterBindings.has(receiver.name)) return
        if (receiver.type === 'MemberExpression'
          && !receiver.computed
          && receiver.property.type === 'Identifier'
          && adapterProperties.has(receiver.property.name)) {
          return
        }
        context.report({ node, messageId: 'providerWrite', data: { name } })
      },
    }
  },
})
