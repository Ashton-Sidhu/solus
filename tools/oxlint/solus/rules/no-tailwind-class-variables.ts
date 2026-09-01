import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// Tailwind must stay readable where the element is. A component that lifts its
// static utility list into a `const` hides the element's real shape from the
// person reading the markup, and the next edit restates half of it inline
// anyway. Shared style modules are a separate, deliberate decision, so this
// rule only reads component files.

/** Utilities that carry no value segment. */
const standaloneUtilities = new Set([
  'antialiased',
  'block',
  'border',
  'capitalize',
  'contents',
  'flex',
  'grid',
  'hidden',
  'inline',
  'inline-block',
  'inline-flex',
  'invisible',
  'italic',
  'absolute',
  'fixed',
  'relative',
  'sticky',
  'rounded',
  'shadow',
  'ring',
  'truncate',
  'underline',
  'uppercase',
  'lowercase',
  'transition',
  'transform',
  'visible',
])

const utilityPrefix =
  /^(?:accent|align|animate|aspect|backdrop|basis|bg|blur|border|bottom|break|caret|col|columns|content|cursor|decoration|delay|divide|duration|ease|fill|flex|font|from|gap|grid|grow|h|indent|inset|items|justify|leading|left|line|list|m|max|mb|min|ml|mr|mt|mx|my|object|opacity|order|origin|outline|overflow|overscroll|p|pb|pl|place|pointer|pr|pt|px|py|right|ring|rotate|rounded|row|scale|scroll|select|self|shadow|shrink|size|skew|space|stroke|text|to|top|touch|tracking|transition|translate|underline|via|w|whitespace|will|z)-/

/** A class token after its variants (`hover:`, `md:`, `[&>*]:`) are removed. */
function baseUtility(token: string): string {
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index]
    if (character === '[' || character === '(') depth += 1
    else if (character === ']' || character === ')') depth -= 1
    else if (character === ':' && depth === 0) start = index + 1
  }
  return token.slice(start).replace(/^[-!]+/, '')
}

function isUtility(token: string): boolean {
  const base = baseUtility(token)
  if (base.length === 0) return false
  if (base.startsWith('[')) return true
  if (standaloneUtilities.has(base)) return true
  return utilityPrefix.test(base)
}

/** Tailwind reads as a list of utilities, so a lone `'flex'` stays a string. */
function isClassList(value: string): boolean {
  const tokens = value.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return false
  const utilities = tokens.filter(isUtility)
  return utilities.length >= 2 && utilities.length * 2 >= tokens.length
}

/** The string an initializer resolves to, or null when it is not static. */
function staticString(node: ESTree.Expression): string | null {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null
  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length > 0) return null
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left)
    const right = staticString(node.right)
    if (left === null || right === null) return null
    return left + right
  }
  return null
}

/** Keep static Tailwind utility lists inline on the element. */
export const noTailwindClassVariablesRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow static Tailwind class lists declared as const or let variables inside component files.',
    },
    messages: {
      hiddenClassList:
        'Write this Tailwind utility list inline on the element. Extract it only when it is real component state or shared by unrelated importers, and then put it in a style module outside the component.',
    },
  },
  create(context) {
    if (!context.filename.endsWith('.svelte') && !context.filename.endsWith('.svelte.ts')) {
      return {}
    }

    return {
      VariableDeclarator(node) {
        if (!node.init) return
        const value = staticString(node.init)
        if (value === null || !isClassList(value)) return
        context.report({ node, messageId: 'hiddenClassList' })
      },
    }
  },
})
