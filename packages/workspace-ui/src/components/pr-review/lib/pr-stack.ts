import type { PrStack, PrStackLayer } from '@solus/contracts/providers'
import type { PrStatusKey } from '../../prs/lib/prs-list-view'

/** A layer's place counted from the bottom, as GitHub numbers it; 0 when the
 *  pull request is not a layer of this stack (it left since the read). */
export function stackPosition(stack: PrStack, number: number): number {
  return stack.layers.findIndex((layer) => layer.number === number) + 1
}

/** The lifecycle glyph a layer shows, in the list's own vocabulary. */
export function stackLayerStatus(layer: PrStackLayer): PrStatusKey {
  if (layer.state !== 'open') return layer.state
  return layer.draft ? 'draft' : 'open'
}
