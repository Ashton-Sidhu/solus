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

/** Disallow standalone named functions that only forward their parameters to another call. */
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
    },
  },
  create(context) {
    const inspect = (node: FunctionNode) => {
      if (!isTopLevel(node) || !isNamedWrapper(node)) return
      const call = returnedCall(node)
      if (call === null || !forwardsParametersUnchanged(node, call)) return
      context.report({ node, messageId: 'passThroughWrapper' })
    }

    return {
      ArrowFunctionExpression: inspect,
      FunctionDeclaration: inspect,
      FunctionExpression: inspect,
    }
  },
})
