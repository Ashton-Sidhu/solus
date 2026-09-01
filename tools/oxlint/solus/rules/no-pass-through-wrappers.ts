import { defineRule } from '@oxlint/plugins'

import type { ESTree } from '@oxlint/plugins'

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function

function isTopLevel(node: FunctionNode): boolean {
  let current: ESTree.Node = node
  while (current.parent.type !== 'Program') {
    const parent = current.parent
    if (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') {
      current = parent
      continue
    }
    if (parent.type === 'VariableDeclarator' || parent.type === 'VariableDeclaration') {
      current = parent
      continue
    }
    return false
  }
  return true
}

/**
 * A method on a class that answers to nobody but itself.
 *
 * A class with an `implements` or `extends` clause is excluded, because a method
 * that looks empty there may be the whole point: an adapter satisfying a
 * provider interface has to declare the member even when its body forwards, and
 * deleting it breaks the contract rather than tidying it.
 */
function isFreeClassMethod(node: FunctionNode): boolean {
  const parent = node.parent
  if (parent.type !== 'MethodDefinition' && parent.type !== 'PropertyDefinition') return false
  if (parent.value !== node || parent.parent.type !== 'ClassBody') return false

  const declaration = parent.parent.parent
  if (declaration.type !== 'ClassDeclaration' && declaration.type !== 'ClassExpression') return false
  return !declaration.superClass && !declaration.implements?.length
}

function returnedCall(node: FunctionNode): ESTree.CallExpression | null {
  if (node.body === null) return null
  if (node.body.type === 'CallExpression') return node.body
  if (node.body.type !== 'BlockStatement' || node.body.body.length !== 1) return null

  const statement = node.body.body[0]
  if (statement.type !== 'ReturnStatement' || statement.argument?.type !== 'CallExpression') {
    return null
  }
  return statement.argument
}

function isNamedWrapper(node: FunctionNode): boolean {
  if (node.type === 'FunctionDeclaration') return true

  const parent = node.parent
  return parent.type === 'VariableDeclarator' && parent.init === node
}

function forwardedParameterName(parameter: ESTree.ParamPattern): string | null {
  if (parameter.type === 'Identifier') return parameter.name
  if (parameter.type !== 'RestElement' || parameter.argument.type !== 'Identifier') return null
  return parameter.argument.name
}

function forwardsParametersUnchanged(node: FunctionNode, call: ESTree.CallExpression): boolean {
  // A member call preserves receiver binding and can therefore justify a
  // wrapper. This rule targets aliases around plain functions only.
  if (call.callee.type !== 'Identifier') return false
  return forwardsParameters(node, call)
}

/** Every parameter reaches the call in order, unchanged and complete. */
function forwardsParameters(node: FunctionNode, call: ESTree.CallExpression): boolean {
  if (node.params.length !== call.arguments.length) return false

  return node.params.every((parameter, index) => {
    const parameterName = forwardedParameterName(parameter)
    if (parameterName === null) return false

    const argument = call.arguments[index]
    if (parameter.type === 'RestElement') {
      return argument.type === 'SpreadElement' &&
        argument.argument.type === 'Identifier' &&
        argument.argument.name === parameterName
    }
    return argument.type === 'Identifier' && argument.name === parameterName
  })
}

/**
 * `outer(this.inner(a, b))` — a method that hands its own object's answer to a
 * function imported from elsewhere, and returns the result.
 *
 * Neither half is hidden by this: the caller holds the object, so it can call
 * `inner` itself, and `outer` is imported from a module it can import too. The
 * method adds a second name for `outer(inner(x))` and nothing else, which is
 * how one call site ends up using the wrapper and the next one the two calls.
 *
 * Two shapes are deliberately not this one. A member callee on the *outside*
 * binds a receiver, so the wrapper does something the caller would have to
 * repeat. And a callee declared in this file may well be private to it, which
 * makes the method the only way to reach it — a narrower interface, which is
 * exactly what earns a wrapper its place.
 */
function forwardsThroughOwnMethod(
  node: FunctionNode,
  call: ESTree.CallExpression,
  imported: ReadonlySet<string>,
): boolean {
  if (call.callee.type !== 'Identifier' || call.arguments.length !== 1) return false
  if (!imported.has(call.callee.name)) return false

  const [argument] = call.arguments
  if (argument.type !== 'CallExpression') return false
  if (argument.callee.type !== 'MemberExpression' || argument.callee.object.type !== 'ThisExpression') {
    return false
  }
  return forwardsParameters(node, argument)
}

/** Disallow named functions and methods that only forward their parameters to another call. */
export const noPassThroughWrappersRule = defineRule({
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow standalone named wrappers that only return another call with the same arguments.',
    },
    messages: {
      passThroughWrapper:
        'Inline this pass-through wrapper, or add validation, defaults, error handling, memoization, or a meaningfully narrower interface.',
      composedWrapper:
        'Inline this wrapper: it only hands one of its own methods to another function, and every caller can already call both.',
    },
  },
  create(context) {
    const imported = new Set<string>()
    const inspect = (node: FunctionNode) => {
      const call = returnedCall(node)
      if (call === null) return
      if (isTopLevel(node) && isNamedWrapper(node) && forwardsParametersUnchanged(node, call)) {
        context.report({ node, messageId: 'passThroughWrapper' })
        return
      }
      // Only a method can compose with its own object, so this shape is only
      // looked for there.
      if (isFreeClassMethod(node) && forwardsThroughOwnMethod(node, call, imported)) {
        context.report({ node, messageId: 'composedWrapper' })
      }
    }

    return {
      // Collected as the file is walked. Imports are hoisted to the top of a
      // module, so every one of them is seen before any method body below it.
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) imported.add(specifier.local.name)
      },
      ArrowFunctionExpression: inspect,
      FunctionDeclaration: inspect,
      FunctionExpression: inspect,
    }
  },
})
