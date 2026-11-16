import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

type SearchCommands = { setText: (text: string) => void }
type SearchNode = { props: { ref: { current: SearchCommands | null }; onChangeText: (event: { nativeEvent: { text: string } }) => void } }
type HeaderNode = { props: { ios: { searchBar: SearchNode } } }
type SearchOptions = { readonly headerSearchValue: string; readonly unstable_headerToolbarItems: () => { type: 'mailSearchToolbar'; onSearchTextChange: (value: string) => void }[] }

// Execute the real adapter with a native search command port. UIKit can reset
// its field during navigation without changing the mounted page's JS filter.
function searchHeaderHarness() {
  const source = readFileSync(new URL('../../apps/mobile/src/native/V5StackHeader.ios.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'element', target: ts.ScriptTarget.ES2022,
  } }).outputText
  let focused = true
  let refIndex = 0
  const refs: { current: unknown }[] = []
  const effects: (() => void)[] = []
  const changes: string[] = []
  const commands: SearchCommands = { setText: (value) => { changes.push(value) } }
  const imports = (name: string) => {
    if (name === 'react') return {
      isValidElement: () => false,
      useRef: (value: unknown) => { const index = refIndex++; return refs[index] ?? (refs[index] = { current: value }) },
      useEffect: () => undefined,
      useLayoutEffect: (effect: () => void) => { effects.push(effect) },
    }
    if (name === '@react-navigation/native') return { useIsFocused: () => focused }
    if (name === 'react-native') return { Platform: { OS: 'ios', isPad: false }, StyleSheet: { flatten: () => undefined } }
    if (name === '../lib/useMobileNavigationTheme') return { useMobileNavigationTheme: () => ({ colors: { card: '#262522' } }) }
    if (name === 'react-native-screens') return { SearchBar: 'SearchBar', Stack: { HeaderConfig: 'HeaderConfig' } }
    throw new Error(`Unexpected header dependency: ${name}`)
  }
  const exports: { V5StackHeader?: (props: { options: SearchOptions; canGoBack: boolean }) => HeaderNode } = {}
  const element = (type: string, props: HeaderNode['props']) => ({ type, props })
  new Function('require', 'exports', 'element', compiled)(imports, exports, element)
  const render = (value: string, onChange: (value: string) => void) => {
    refIndex = 0
    if (!exports.V5StackHeader) throw new Error('Header was not exported')
    const node = exports.V5StackHeader({ canGoBack: true, options: {
      headerSearchValue: value,
      unstable_headerToolbarItems: () => [{ type: 'mailSearchToolbar', onSearchTextChange: onChange }],
    } })
    const search = node.props.ios.searchBar
    search.props.ref.current = commands
    for (const effect of effects.splice(0)) effect()
    return search
  }
  return { render, changes, focus: (value: boolean) => { focused = value } }
}

describe('project picker native search', () => {
  test('Back restores the visible query that still filters the mounted project list', () => {
    const header = searchHeaderHarness()
    let query = ''
    const change = (value: string) => { query = value }
    const field = header.render(query, change)
    field.props.onChangeText({ nativeEvent: { text: 'parity' } })
    header.render(query, change)
    // Typing must not invoke setText and move the cursor after each keystroke.
    expect(header.changes).toEqual([''])
    header.focus(false)
    header.render(query, change)
    header.focus(true)
    header.render(query, change)
    expect(query).toBe('parity')
    expect(header.changes).toEqual(['', 'parity'])
  })

  test('a caller clearing its filter also clears the native field', () => {
    const header = searchHeaderHarness()
    const field = header.render('parity', () => undefined)
    field.props.onChangeText({ nativeEvent: { text: 'parity' } })
    header.render('', () => undefined)
    expect(header.changes).toEqual(['parity', ''])
  })
})
