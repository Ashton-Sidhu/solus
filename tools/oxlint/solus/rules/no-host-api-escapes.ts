import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion

const allowedFiles = new Set([
  'src/client-core/host-api.ts',
  'src/renderer/main.ts',
  'src/client-core/native-api-overlay.ts',
  'src/client-core/local-api.ts',
  'client/src/main.ts',
])

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function isAllowedFile(path: string): boolean {
  return allowedFiles.has(path) || path.startsWith('src/preload/')
}

function isCheckedFile(path: string): boolean {
  return path.startsWith('src/') || path.startsWith('client/src/')
}

function assertedTypeName(node: TypeAssertion): string | null {
  const annotation = node.typeAnnotation
  if (annotation.type !== 'TSTypeReference' || annotation.typeName.type !== 'Identifier') return null
  return annotation.typeName.name
}

function isAmbientSolusType(node: TypeAssertion): boolean {
  const annotation = node.typeAnnotation
  if (annotation.type !== 'TSTypeQuery') return false
  const expression = annotation.exprName
  return expression.type === 'TSQualifiedName'
    && expression.left.type === 'Identifier'
    && expression.left.name === 'window'
    && expression.right.name === 'solus'
}

function isApiHandleCastToAny(node: TypeAssertion): boolean {
  if (node.typeAnnotation.type !== 'TSAnyKeyword' || node.expression.type !== 'Identifier') return false
  return node.expression.name === 'solus' || /(?:Api|api)$/u.test(node.expression.name)
}

function isWindowSolusMember(node: ESTree.Expression): boolean {
  if (node.type !== 'MemberExpression' || node.computed) return false
  return node.object.type === 'Identifier'
    && node.object.name === 'window'
    && node.property.type === 'Identifier'
    && node.property.name === 'solus'
}

/** Prevent call sites from escaping the host-addressed API boundary. */
export const noHostApiEscapesRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent ambient Solus API access and casts that counterfeit a host API.',
    },
    messages: {
      hostApiCast: 'Do not cast a value to {{name}}. Resolve the typed API from serverConnections.',
      ambientSolusType: 'Do not recover the ambient window.solus type. Use the explicit host or local API contract.',
      apiAnyCast: 'Do not cast an API handle to any. Keep the host API contract intact.',
      ambientSolusAccess: 'Do not call the ambient window.solus API. Use an explicit host API or localApi.',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!isCheckedFile(path) || isAllowedFile(path)) return {}

    const checkAssertion = (node: TypeAssertion) => {
      const typeName = assertedTypeName(node)
      if (typeName === 'HostApi' || typeName === 'SolusAPI') {
        context.report({ node, messageId: 'hostApiCast', data: { name: typeName } })
        return
      }
      if (isAmbientSolusType(node)) {
        context.report({ node, messageId: 'ambientSolusType' })
        return
      }
      if (isApiHandleCastToAny(node)) context.report({ node, messageId: 'apiAnyCast' })
    }

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
      MemberExpression(node) {
        if (isWindowSolusMember(node.object)) {
          context.report({ node, messageId: 'ambientSolusAccess' })
        }
      },
    }
  },
})
