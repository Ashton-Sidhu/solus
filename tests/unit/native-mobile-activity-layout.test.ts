import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { SOLUS_DARK_THEME_COLORS, SOLUS_LIGHT_THEME_COLORS } from '../../apps/mobile/src/theme/theme-colors'
import type { AgentActivityCard, AgentActivityPhase } from '@solus/contracts/uplink'

type Modifier = { name: string; value: unknown }
type Child = Node | string | number | boolean | null | undefined
type Node = { type: string; props: { modifiers?: Modifier[]; systemName?: string }; children: Child[] }
type Environment = { colorScheme: 'light' | 'dark'; isStale?: boolean; isLuminanceReduced?: boolean }
type Layout = { banner: Node; bannerSmall: Node; compactLeading: Node; compactTrailing: Node; minimal: Node; expandedLeading: Node; expandedBottom: Node }

// Execute the serialized widget with view factories, without loading native Expo modules.
// This also rejects an accidental dependency on app-only palette or routing helpers.
function loadWidget() {
  const source = readFileSync(new URL('../../apps/mobile/src/widgets/AgentActivity.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'element', target: ts.ScriptTarget.ES2022,
  } }).outputText
  const views = { HStack: 'HStack', Image: 'Image', Spacer: 'Spacer', Text: 'Text', VStack: 'VStack', ZStack: 'ZStack' }
  const modifiers = Object.fromEntries(['accessibilityElement', 'accessibilityLabel', 'activityBackgroundTint', 'font', 'foregroundStyle', 'frame', 'layoutPriority', 'lineLimit', 'minimumScaleFactor', 'padding', 'resizable', 'widgetURL'].map((name) => [name, (value: unknown) => ({ name, value })]))
  const imports = (name: string) => {
    if (name === '@expo/ui/swift-ui') return views
    if (name === '@expo/ui/swift-ui/modifiers') return modifiers
    if (name === 'expo-widgets') return { createLiveActivity: () => null }
    if (name === '@solus/contracts/uplink') return { AGENT_ACTIVITY_NAME: 'AgentActivity' }
    throw new Error(`Widget has an app-only dependency: ${name}`)
  }
  const exports: { AgentActivity?: (card: AgentActivityCard, environment: Environment) => Layout } = {}
  const element = (type: string, props: Node['props'] | null, ...children: Child[]): Node => ({ type, props: props ?? {}, children })
  new Function('require', 'exports', 'element', compiled)(imports, exports, element)
  if (!exports.AgentActivity) throw new Error('Widget did not export its layout')
  return exports.AgentActivity
}
const widget = loadWidget()
function card(phase: AgentActivityPhase = 'running'): AgentActivityCard {
  return { title: 'Solus', subtitle: 'Working', activeCount: 1, updatedAt: '', activities: [{
    hostId: 'host-a', sessionId: 'session-a', threadTitle: 'Task A', projectTitle: 'Project A', modelTitle: '', phase, status: 'Working', updatedAt: '', deepLink: '/thread/host-a/session-a',
  }] }
}
function all(node: Node): Node[] {
  return [node, ...node.children.flatMap((child) => typeof child === 'object' && child !== null ? all(child) : [])]
}
const values = (node: Node, name: string) => all(node).flatMap((item) => item.props.modifiers?.filter((modifier) => modifier.name === name).map((modifier) => modifier.value) ?? [])
const textOf = (node: Node) => all(node).flatMap((item) => item.children.filter((child) => typeof child === 'string'))

describe('Live Activity presentation', () => {
  test.each(['light', 'dark'] as const)('Lock Screen inherits the system material and readable %s foregrounds', (colorScheme) => {
    const layout = widget(card(), { colorScheme })
    expect(values(layout.banner, 'activityBackgroundTint')).toEqual([null])
    expect(values(layout.banner, 'foregroundStyle')).toContainEqual({ type: 'hierarchical', style: 'primary' })
    expect(values(layout.banner, 'foregroundStyle')).toContainEqual({ type: 'hierarchical', style: 'secondary' })
  })

  test.each(['light', 'dark'] as const)('input status keeps the Solus %s accent', (colorScheme) => {
    const layout = widget(card('waiting_for_input'), { colorScheme })
    const palette = colorScheme === 'light' ? SOLUS_LIGHT_THEME_COLORS : SOLUS_DARK_THEME_COLORS
    expect(values(layout.banner, 'foregroundStyle')).toContain(palette.accent)
  })

  test.each(['running', 'waiting_for_input', 'waiting_for_approval', 'failed'] as const)('every tappable presentation opens its session (%s)', (phase) => {
    const layout = widget(card(phase), { colorScheme: 'dark' })
    for (const node of [layout.banner, layout.compactLeading, layout.compactTrailing, layout.minimal, layout.expandedBottom]) {
      expect(values(node, 'widgetURL')).toContain('solus://thread/host-a/session-a')
    }
  })

  test('an untrusted link never becomes a widget destination', () => {
    const input = card()
    const row = input.activities[0]!
    const layout = widget({ ...input, activities: [{ ...row, deepLink: '//other-app/path' }] }, { colorScheme: 'dark' })
    for (const node of [layout.banner, layout.compactLeading, layout.compactTrailing, layout.minimal]) expect(values(node, 'widgetURL')).toEqual([])
  })

  test('expired work offers a quiet refresh action without claiming agents are active', () => {
    const layout = widget(card(), { colorScheme: 'dark', isStale: true })
    expect(textOf(layout.banner)).toContain('Tap to refresh')
    expect(textOf(layout.banner)).toContain('Check status')
    for (const node of [layout.banner, layout.bannerSmall, layout.compactLeading, layout.compactTrailing, layout.minimal, layout.expandedLeading, layout.expandedBottom]) {
      expect(textOf(node)).not.toContain('Working')
      expect(textOf(node).join(' ')).not.toMatch(/out of date|1 active/i)
      expect(values(node, 'widgetURL')).toContain('solus://thread/host-a/session-a')
    }
    expect(textOf(layout.expandedLeading)).toContain('Refresh')
    expect(all(layout.compactTrailing).some((node) => node.props.systemName === 'clock.arrow.circlepath')).toBe(true)
  })

  test('refresh opens the unconfirmed session while keeping known outcomes visible', () => {
    const input = card()
    const done = { ...input.activities[0]!, sessionId: 'done', threadTitle: 'Finished task', phase: 'completed' as const, status: 'Done', deepLink: '/thread/host-a/done' }
    const failed = { ...done, sessionId: 'failed', phase: 'failed' as const, status: 'Failed', deepLink: '/thread/host-a/failed' }
    const layout = widget({ ...input, activities: [failed, done, ...input.activities] }, { colorScheme: 'dark', isStale: true })
    expect(textOf(layout.banner)).toContain('Done')
    expect(textOf(layout.banner)).toContain('Failed')
    expect(textOf(layout.banner)).toContain('Check status')
    expect(values(layout.banner, 'widgetURL')).toEqual(['solus://thread/host-a/session-a'])
    expect(all(layout.minimal).some((node) => node.props.systemName === 'clock.arrow.circlepath')).toBe(true)
  })

  test('a fresh update restores status and an ended card keeps its outcome after expiry', () => {
    expect(textOf(widget(card(), { colorScheme: 'light' }).banner)).toContain('Working')
    const input = card('completed')
    const layout = widget({ ...input, activeCount: 0, activities: input.activities.map((row) => ({ ...row, status: 'Done' })) }, { colorScheme: 'light', isStale: true })
    expect(textOf(layout.banner)).toContain('Agent work completed')
    expect(textOf(layout.banner)).not.toContain('Tap to refresh')
  })
})
