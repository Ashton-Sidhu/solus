import { describe, expect, test } from 'bun:test'
import {
  expandScale,
  needsSandbox,
} from '../../packages/workspace-ui/src/components/artifact/lib/artifact-view'

describe('what has to run in the sandbox frame', () => {
  // WHY: the routing rule is about fidelity, not safety. The frame is the only
  // place a stylesheet or a script runs, so markup that carries its own goes
  // there. Plain markup reads better in the host DOM under the app's prose
  // styles, and putting it in a frame would strip it of them.
  test('markup carrying its own styles, behaviour, or document goes to the frame', () => {
    expect(needsSandbox('<div><style>p{color:red}</style><p>hi</p></div>')).toBe(true)
    expect(needsSandbox('<div><script>run()</script></div>')).toBe(true)
    expect(needsSandbox('<link rel="stylesheet" href="https://x/y.css">')).toBe(true)
    expect(needsSandbox('<svg viewBox="0 0 8 8"><circle r="4"/></svg>')).toBe(true)
    expect(needsSandbox('<canvas id="c"></canvas>')).toBe(true)
    expect(needsSandbox('<!doctype html><html><body>x</body></html>')).toBe(true)
    expect(needsSandbox('<html><body>x</body></html>')).toBe(true)
  })

  test('plain markup stays in the host DOM', () => {
    expect(needsSandbox('<table><tr><td>1</td></tr></table>')).toBe(false)
    expect(needsSandbox('<div style="color:red">inline styles are not a stylesheet</div>')).toBe(false)
    expect(needsSandbox('<details><summary>More</summary>body</details>')).toBe(false)
    expect(needsSandbox('const style = "x"; if (a < b) {}')).toBe(false)
  })

  test('a word that merely starts with a marker is not one', () => {
    // WHY: `<linkage>` and `<scripture>` are not `<link>` and `<script>`. A
    // prefix test would send an ordinary fragment to a frame that strips it of
    // the app's prose styles.
    expect(needsSandbox('<linkage>x</linkage>')).toBe(false)
    expect(needsSandbox('<htmlish>x</htmlish>')).toBe(false)
  })
})

describe('the expand zoom', () => {
  test('fits the inline render into the overlay with a margin', () => {
    expect(expandScale(500, 250, { w: 1000, h: 1000 })).toBeCloseTo(2 * 0.92)
    expect(expandScale(500, 1000, { w: 1000, h: 500 })).toBeCloseTo(0.5 * 0.92)
  })

  test('stays at 1 before anything has been measured', () => {
    // WHY: a zero scale collapses the iframe to nothing on the first frame
    // after expanding, before the overlay has been observed.
    expect(expandScale(0, 250, { w: 1000, h: 1000 })).toBe(1)
    expect(expandScale(500, 0, { w: 1000, h: 1000 })).toBe(1)
    expect(expandScale(500, 250, { w: 0, h: 0 })).toBe(1)
  })
})
