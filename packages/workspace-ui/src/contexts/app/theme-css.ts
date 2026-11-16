/**
 * Paints the person's theme CSS (docs/theme-css.md) into one adopted
 * stylesheet. Adopted sheets order after the document's own, and they cannot
 * hold @import.
 *
 * Theme CSS comes from agents and from pastes, so it must not load a file: a
 * url() on an attribute selector can send what is on screen to another host.
 * The browser parses the text first, so each check sees a normalized value, and
 * a CSS escape in a function name cannot get past it.
 */

import { themeCssValueLoadsFile } from '@solus/contracts/theme-css'

/** The parts of a CSSOM declaration block the guard reads. */
interface ThemeDeclarations {
  readonly length: number
  item(index: number): string
  getPropertyValue(property: string): string
  removeProperty(property: string): string
}

/** A CSSOM rule as the guard tells its kinds apart: by the members each kind has. */
interface ThemeRule {
  readonly cssText: string
  readonly style?: ThemeDeclarations
  readonly cssRules?: ArrayLike<ThemeRule>
  deleteRule?(index: number): void
  /** Only @keyframes has it. */
  readonly appendRule?: unknown
  /** Only @property has it. */
  readonly initialValue?: string | null
  /** Only the `@layer a, b;` statement has it. */
  readonly nameList?: unknown
  /** Only @namespace has it. */
  readonly namespaceURI?: string
}

export interface ThemeRuleParent {
  readonly cssRules: ArrayLike<ThemeRule>
  deleteRule(index: number): void
}

function stripDeclarations(style: ThemeDeclarations): void {
  for (let index = style.length - 1; index >= 0; index--) {
    const property = style.item(index)
    if (themeCssValueLoadsFile(style.getPropertyValue(property))) style.removeProperty(property)
  }
}

function isRuleParent(rule: ThemeRule): rule is ThemeRule & ThemeRuleParent {
  return rule.cssRules !== undefined && rule.deleteRule !== undefined
}

/** Keeps only the rule kinds it can check, so a new at-rule that loads a file is dropped by default. */
export function stripFileLoads(parent: ThemeRuleParent): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index]
    if (!rule) continue
    if (rule.style) stripDeclarations(rule.style)
    if (rule.appendRule !== undefined) {
      // @keyframes: its deleteRule takes a keyframe selector, so only its declarations are checked.
      for (const frame of Array.from(rule.cssRules ?? [])) if (frame.style) stripDeclarations(frame.style)
    } else if (isRuleParent(rule)) {
      stripFileLoads(rule)
    } else if (rule.initialValue !== undefined) {
      // A registered property's initial value is used wherever var() reads it.
      if (themeCssValueLoadsFile(rule.initialValue ?? '')) parent.deleteRule(index)
    } else if (!rule.style && rule.nameList === undefined && rule.namespaceURI === undefined) {
      // A namespace names a namespace without loading it; CSSOM refuses to delete one while style rules remain.
      parent.deleteRule(index)
    }
  }
}

let themeSheet: CSSStyleSheet | null = null
let appliedCss = ''

/** Replaces the painted theme CSS. The same text twice costs nothing. */
export function applyThemeCss(css: string): void {
  if (css === appliedCss) return
  appliedCss = css
  if (!themeSheet) {
    themeSheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, themeSheet]
  }
  themeSheet.replaceSync(css)
  stripFileLoads(themeSheet)
}
