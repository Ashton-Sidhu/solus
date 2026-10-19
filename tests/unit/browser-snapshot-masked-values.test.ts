import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { elementSnapshotExpression } from '@solus/server/browser/page-script'

// WHY: a page masks a value when a person should not see it on screen. The
// snapshot is sent over the browser RPC and kept with the page record, so it
// must not carry what the page itself hides. Synthetic markers only.

class FieldFixture {
  textContent = ''
  disabled = false
  id = ''
  constructor(
    readonly tagName: string,
    readonly type: string,
    readonly value: string,
    readonly textSecurity: string | null = null,
    private readonly placeholder = 'Fixture field',
  ) {}
  getAttribute(name: string): string | null {
    if (name === 'type') return this.type
    if (name === 'placeholder') return this.placeholder
    return null
  }
  setAttribute() {}
  removeAttribute() {}
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, bottom: 20, width: 100, height: 20 } }
}

type Snapshot = { elements: Array<{ label: string; value?: string }> }

function snapshot(fields: FieldFixture[], styleOf: (field: FieldFixture) => object): Snapshot {
  return JSON.parse(runInNewContext(elementSnapshotExpression(50), {
    document: { title: 'Fixture form', querySelectorAll: (selector: string) => selector.startsWith('[') ? [] : fields },
    location: { href: 'https://fixture.invalid' },
    window: { innerHeight: 600, getComputedStyle: styleOf },
  }))
}

const visible = { visibility: 'visible', display: 'block' }

describe('element snapshot values', () => {
  test('a password field and a field the page draws as dots give no value; ordinary fields keep theirs', () => {
    const fields = [
      new FieldFixture('INPUT', 'password', 'synthetic-password-marker', null, 'Password'),
      new FieldFixture('INPUT', 'text', 'synthetic-css-mask-marker', 'disc', 'PIN'),
      new FieldFixture('INPUT', 'text', 'synthetic-plain-value', 'none', 'Name'),
      new FieldFixture('TEXTAREA', 'textarea', 'synthetic-notes', null, 'Notes'),
    ]
    const result = snapshot(fields, (field) => ({ ...visible, webkitTextSecurity: field.textSecurity ?? '' }))

    expect(result.elements.map(({ label, value }) => [label, value])).toEqual([
      ['Password', undefined],
      ['PIN', undefined],
      ['Name', 'synthetic-plain-value'],
      ['Notes', 'synthetic-notes'],
    ])
    const raw = JSON.stringify(result)
    expect(raw).not.toContain('synthetic-password-marker')
    expect(raw).not.toContain('synthetic-css-mask-marker')
  })

  test('a mask set through the standard property name is honored too', () => {
    const fields = [new FieldFixture('INPUT', 'text', 'synthetic-css-mask-marker', 'circle', 'Code')]
    const result = snapshot(fields, (field) => ({
      ...visible,
      getPropertyValue: (name: string) => name === '-webkit-text-security' ? field.textSecurity : '',
    }))
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0]!.value).toBeUndefined()
  })
})
