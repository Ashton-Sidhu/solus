import type {
  PrMergeMethod,
  PrStack,
  PrStackHead,
  PrStackLayer,
  PrStackMergeResult,
  PullRequest,
} from '@solus/contracts/providers'
import type { PrStatusKey } from '../../prs/lib/prs-list-view'
import { defaultMergeMethod } from './merge-method'
import { prActionAllowed } from './merge-readiness'

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

/** What "Merge stack" lands: every open layer from the bottom up to this one. */
export interface StackMergePlan {
  stackNumber: number
  /** The method every layer lands with: the one the merge button starts on. */
  method: PrMergeMethod
  /** Bottom first, ending with the pull request the merge is asked for. */
  layers: PrStackLayer[]
  /** One head per layer, as the stack read gave them. Null when the read left
   *  a head out: the host refuses a merge it cannot check. */
  expectedHeads: PrStackHead[] | null
}

/**
 * The stack merge to offer for `detail`, or null when there is none: the host
 * does not offer it, the viewer may not, the pull request is in no stack, or
 * it is not an open layer of the stack read. A detail read that did not ask
 * about stacks (`stack` absent) leaves the answer to the stack read.
 */
export function stackMergePlan(detail: PullRequest, stack: PrStack | null): StackMergePlan | null {
  if (detail.stack === null || !stack || detail.state !== 'open' || !prActionAllowed(detail, 'merge-stack')) return null
  const position = stackPosition(stack, detail.number)
  if (position === 0) return null
  const layers = stack.layers.slice(0, position).filter((layer) => layer.state === 'open')
  return {
    stackNumber: stack.number,
    method: defaultMergeMethod(detail.capabilities),
    layers,
    expectedHeads: stackExpectedHeads(layers),
  }
}

export function stackExpectedHeads(layers: readonly PrStackLayer[]): PrStackHead[] | null {
  const heads: PrStackHead[] = []
  for (const layer of layers) {
    if (!layer.headSha) return null
    heads.push({ number: layer.number, headSha: layer.headSha })
  }
  return heads
}

/** The toast after a stack merge the host accepted. */
export function stackMergeOutcome(result: PrStackMergeResult): string {
  const count = result.pullRequests.length
  const noun = count === 1 ? 'pull request' : 'pull requests'
  return result.status === 'queued'
    ? `${count} ${noun} added to the merge queue`
    : `${count} ${noun} merged`
}
