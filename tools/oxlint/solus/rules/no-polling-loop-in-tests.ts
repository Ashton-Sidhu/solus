import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// A test that spins in a loop, sleeping on a timer until a predicate holds, is
// timing- and load-dependent: it passes on a quiet laptop and fails on a busy
// CI runner, and every iteration it waits is time the suite pays. The test
// should await the event, promise, or callback that marks the milestone.
//
// A loop counts as polling when two things hold:
//   1. its body waits on a timer: an awaited `new Promise` whose executor
//      schedules `setTimeout` or `setImmediate`, `await Promise.resolve()`, or
//      an awaited sleep helper (`sleep`, `delay`, `Bun.sleep`, the promise
//      form of `setTimeout`);
//   2. a predicate decides whether it continues: a conditional exit in its
//      body, or a loop test that is neither `true` nor a counter the loop
//      itself advances. A fixed-count flush (`for (i = 0; i < 3; i++)`) is not
//      polling.
//
// Waits inside a nested function do not count: they run on the callback's
// schedule, not the loop's. A wait hidden behind another local helper is not
// seen; the rule reads only what is written in the loop.

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])
const COUNTER_OPERATORS = new Set(['<', '<=', '>', '>='])
const TIMERS = new Set(['setImmediate', 'setTimeout'])
const SLEEP_HELPERS = new Set(['sleep', 'delay', 'setTimeout'])

type LoopNode = ESTree.ForStatement | ESTree.WhileStatement | ESTree.DoWhileStatement
type Visited = ESTree.Node | readonly Visited[] | string | number | boolean | bigint | RegExp | null | undefined

function isNode(value: Visited): value is ESTree.Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value
}

/** Visits `node` and its descendants, skipping nested functions. */
function someDescendant(node: Visited, match: (node: ESTree.Node) => boolean): boolean {
  if (Array.isArray(node)) return node.some((child: Visited) => someDescendant(child, match))
  if (!isNode(node)) return false
  if (match(node)) return true
  if (FUNCTIONS.has(node.type)) return false
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue
    if (someDescendant(value, match)) return true
  }
  return false
}

/** The expression under parentheses, `as`, `!`, and `satisfies`. */
function unwrap(node: ESTree.Node | null | undefined): ESTree.Node | null {
  let current = node ?? null
  while (
    current &&
    (current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'ChainExpression')
  ) {
    current = current.expression
  }
  return current
}

function isIdentifierNamed(node: ESTree.Node | null | undefined, names: ReadonlySet<string>): boolean {
  const expression = unwrap(node)
  return expression?.type === 'Identifier' && names.has(expression.name)
}

function isMember(node: ESTree.Node | null | undefined, object: string | null, property: string): boolean {
  const expression = unwrap(node)
  if (expression?.type !== 'MemberExpression' || expression.computed) return false
  if (expression.property.type !== 'Identifier' || expression.property.name !== property) return false
  if (object === null) return true
  const owner = unwrap(expression.object)
  return owner?.type === 'Identifier' && owner.name === object
}

/** `Promise.resolve()`, or a `new Promise` whose executor schedules a timer. */
function isTickPromise(node: ESTree.Node | null | undefined): boolean {
  const expression = unwrap(node)
  if (!expression) return false
  if (expression.type === 'CallExpression') return isMember(expression.callee, 'Promise', 'resolve')
  if (expression.type !== 'NewExpression' || !isIdentifierNamed(expression.callee, new Set(['Promise']))) return false
  const [executor] = expression.arguments
  if (isIdentifierNamed(executor, TIMERS)) return true
  if (executor?.type !== 'ArrowFunctionExpression' && executor?.type !== 'FunctionExpression') return false
  return someDescendant(executor.body,(child) => child.type === 'CallExpression' && isIdentifierNamed(child.callee, TIMERS))
}

/** `sleep(ms)`, `delay(ms)`, `setTimeout(ms)` from `timers/promises`, `Bun.sleep(ms)`. */
function isSleepCall(node: ESTree.Node | null | undefined): boolean {
  const expression = unwrap(node)
  if (expression?.type !== 'CallExpression') return false
  return isIdentifierNamed(expression.callee, SLEEP_HELPERS) || isMember(expression.callee, null, 'sleep')
}

function isWait(node: ESTree.Node): boolean {
  if (node.type === 'AwaitExpression') return isTickPromise(node.argument) || isSleepCall(node.argument)
  if (node.type === 'NewExpression') return isTickPromise(node)
  return node.type === 'CallExpression' && isIdentifierNamed(node.callee, new Set(['setImmediate']))
}

function hasConditionalExit(body: ESTree.Node): boolean {
  return someDescendant(
    body,
    (node) =>
      node.type === 'IfStatement' &&
      someDescendant(
        [node.consequent, node.alternate],
        (child) => child.type === 'ReturnStatement' || child.type === 'BreakStatement' || child.type === 'ThrowStatement',
      ),
  )
}

function isNumericBound(node: ESTree.Node): boolean {
  const expression = unwrap(node)
  return expression?.type === 'Identifier' || (expression?.type === 'Literal' && typeof expression.value === 'number')
}

function updatesCounter(node: Visited, name: string): boolean {
  const named = new Set([name])
  return someDescendant(
    node,
    (child) =>
      (child.type === 'UpdateExpression' && isIdentifierNamed(child.argument, named)) ||
      (child.type === 'AssignmentExpression' &&
        (child.operator === '+=' || child.operator === '-=') &&
        isIdentifierNamed(child.left, named)),
  )
}

// A bare counter (`i < 3`, `attempt < max`) that the loop itself advances
// bounds the loop without asking anything about the system under test.
// `events.length < 1` or a counter nobody increments is a predicate.
function isCounterTest(loop: LoopNode): boolean {
  const test = unwrap(loop.test)
  if (test?.type !== 'BinaryExpression' || !COUNTER_OPERATORS.has(test.operator)) return false
  const advances = [loop.body, loop.type === 'ForStatement' ? loop.update : null]
  return [
    [test.left, test.right],
    [test.right, test.left],
  ].some(([counter, bound]) => {
    const name = unwrap(counter)
    return name?.type === 'Identifier' && isNumericBound(bound) && updatesCounter(advances, name.name)
  })
}

function isTrueLiteral(node: ESTree.Node): boolean {
  const expression = unwrap(node)
  return expression?.type === 'Literal' && expression.value === true
}

function hasPredicateExit(loop: LoopNode): boolean {
  return hasConditionalExit(loop.body) || (loop.test != null && !isTrueLiteral(loop.test) && !isCounterTest(loop))
}

/** Tests await the milestone they need instead of polling for it on a timer. */
export const noPollingLoopInTestsRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow loops in tests that sleep on a timer until a predicate holds; await the milestone instead.',
    },
    messages: {
      pollingLoop:
        'Polling loop in a test. Sleeping on a timer until a condition holds is timing- and load-dependent. Await the promise, event, or callback that marks the milestone.',
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {}

    const check = (loop: LoopNode) => {
      if (!someDescendant(loop.body, isWait)) return
      if (!hasPredicateExit(loop)) return
      context.report({ node: loop, messageId: 'pollingLoop' })
    }

    return {
      ForStatement: check,
      WhileStatement: check,
      DoWhileStatement: check,
    }
  },
})
