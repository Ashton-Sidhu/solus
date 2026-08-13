import { defineRule } from '@oxlint/plugins'

/** Disallow the broad built-in Record<string, unknown> type. */
export const noBroadUnknownRecordsRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow Record<string, unknown> in authored code.',
    },
    messages: {
      broadUnknownRecord:
        'Define the exact object shape with a domain-specific type. Do not replace this type with object, unknown, a broad index signature, a type assertion, or a renamed loose alias.',
    },
  },
  create(context) {
    return {
      TSTypeReference(node) {
        if (node.typeName.type !== 'Identifier' || node.typeName.name !== 'Record') return
        const parameters = node.typeArguments?.params
        if (parameters?.length !== 2) return
        if (parameters[0].type !== 'TSStringKeyword' || parameters[1].type !== 'TSUnknownKeyword') {
          return
        }
        context.report({ node, messageId: 'broadUnknownRecord' })
      },
    }
  },
})
