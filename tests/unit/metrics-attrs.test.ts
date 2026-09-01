import { describe, expect, test } from 'bun:test'
import type { MetricsSpanAttrs } from '@solus/contracts/observability-types'
import { KIND_REGISTRY } from '@solus/server/observability/field-registry'

// `MetricsSpanAttrs` is the read side of the span field registry: the registry
// names each attribute and its type, generates the SQL views from that, and the
// contract declares the same set so a reader gets a typed value instead of a
// union to narrow.
//
// Nothing derives one from the other — the registry is runtime data built by
// helper calls, and the contract is a type. These tests are the join. A new
// `attr(...)` in the registry that nobody added to the contract fails here, not
// silently as `undefined` at some reader months later.

/** Every attribute name the registry declares, across all kinds, with its
 *  declared type. `duration` is a number on the wire. */
function registeredAttrs(): Map<string, 'string' | 'number' | 'boolean'> {
  const attrs = new Map<string, 'string' | 'number' | 'boolean'>()
  for (const registration of Object.values(KIND_REGISTRY)) {
    for (const field of registration.fields) {
      if (field.storage.source !== 'attr') continue
      attrs.set(field.storage.path, field.type === 'duration' ? 'number' : field.type)
    }
  }
  return attrs
}

/** The contract's own field names. A type has no runtime presence, so this
 *  states them once; the two tests below prove the list is neither short nor
 *  long against the registry. */
const DECLARED: Record<keyof MetricsSpanAttrs, 'string' | 'number' | 'boolean'> = {
  costUsd: 'number',
  inputTokens: 'number',
  outputTokens: 'number',
  cacheReadTokens: 'number',
  cacheCreationTokens: 'number',
  interTurnIdleMs: 'number',
  timeToFirstActivityMs: 'number',
  timeToFirstTextMs: 'number',
  timeToFirstProviderEventMs: 'number',
  timeToLastProviderEventMs: 'number',
  timeToProviderCompleteMs: 'number',
  automationName: 'string',
  automationId: 'string',
  taskTitle: 'string',
  taskId: 'string',
  projectName: 'string',
  branch: 'string',
  hostname: 'string',
  hostOs: 'string',
  promptSource: 'string',
  isResume: 'boolean',
  hasThinking: 'boolean',
  prompt: 'string',
  promptTruncated: 'boolean',
  systemPrompt: 'string',
  systemPromptChars: 'number',
  systemPromptTruncated: 'boolean',
  response: 'string',
  responseChars: 'number',
  responseTruncated: 'boolean',
  promptChars: 'number',
  reasoningEffort: 'string',
  toolCallCount: 'number',
  permissionDenialCount: 'number',
  input: 'string',
  inputTruncated: 'boolean',
  declined: 'boolean',
  providerDurationMs: 'number',
  isSubagent: 'boolean',
  parentToolUseId: 'string',
  error: 'string',
  exitCode: 'number',
  outcomeStatus: 'string',
  decision: 'string',
  questionCount: 'number',
  trigger: 'string',
  blocking: 'boolean',
  toolUseId: 'string',
  timedOut: 'boolean',
  step: 'string',
  fn: 'string',
  file: 'string',
  // Synthesised client-side for gap pseudo-spans, so the registry has neither.
  category: 'string',
  description: 'string',
}

/** The two the waterfall invents for a gap it draws as a span. */
const CLIENT_SYNTHESISED = new Set(['category', 'description'])

describe('span attributes are declared once', () => {
  test('every registry attribute is readable through the contract', () => {
    const missing = [...registeredAttrs().keys()].filter((name) => !(name in DECLARED))

    expect(missing).toEqual([])
  })

  test('the contract declares no attribute the registry does not', () => {
    const registered = registeredAttrs()
    const extra = Object.keys(DECLARED).filter(
      (name) => !registered.has(name) && !CLIENT_SYNTHESISED.has(name),
    )

    expect(extra).toEqual([])
  })

  test('each attribute is declared with the type the registry gives it', () => {
    const mismatched = [...registeredAttrs().entries()]
      .filter(([name, type]) => name in DECLARED && DECLARED[name as keyof MetricsSpanAttrs] !== type)
      .map(([name, type]) => `${name}: registry says ${type}, contract says ${DECLARED[name as keyof MetricsSpanAttrs]}`)

    expect(mismatched).toEqual([])
  })
})
