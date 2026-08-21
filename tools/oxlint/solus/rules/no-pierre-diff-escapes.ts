import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// @pierre/diffs parses a patch into source-file row coordinates, but its
// virtualizer walks a partial diff as compact rows. A surface that parses its
// own files hands the renderer the wrong space, and the mismatch surfaces as
// "DiffHunksRenderer.processDiffResult: deletionLine and additionLine are null".
// lib/pierre-diff owns that normalization, so it owns the parse.
const guardedImports = new Set([
  'parsePatchFiles',
  'processFile',
  'processPatch',
  'hydratePartialDiff',
])

const renderedDiffRoot = 'packages/workspace-ui/src/'
const boundaryModule = 'packages/workspace-ui/src/lib/pierre-diff/'

const allowedFiles = new Set([
  // Move analysis and the heat map read hunk contents and line arrays, and never
  // hand a FileDiffMetadata to a renderer, so row offsets cannot matter to them.
  'packages/workspace-ui/src/lib/diff-moves.ts',
  'packages/workspace-ui/src/components/pr-review/PrReviewPane.svelte',
  // Parses per `diff --git` chunk so a live refresh reuses untouched files, then
  // normalizes both of its parse paths through compactPartialHunkOffsets.
  'packages/workspace-ui/src/lib/diff-state.svelte.ts',
])

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function isPierreDiffs(source: string): boolean {
  return source === '@pierre/diffs' || source.startsWith('@pierre/diffs/')
}

function isTypeOnly(
  declaration: ESTree.ImportDeclaration,
  specifier: ESTree.ImportSpecifier,
): boolean {
  return declaration.importKind === 'type' || specifier.importKind === 'type'
}

/** Keep @pierre/diffs patch parsing behind the lib/pierre-diff boundary. */
export const noPierreDiffEscapesRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Parse @pierre/diffs patches through lib/pierre-diff so every diff surface renders in one row coordinate space.',
    },
    messages: {
      unnormalizedParse:
        'Do not import {{name}} directly. Read files through lib/pierre-diff (parsePatchMetadata, or compactPartialHunkOffsets on a chunk-cached parse) so the renderer gets compact hunk offsets.',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!path.startsWith(renderedDiffRoot)) return {}
    if (path.startsWith(boundaryModule) || allowedFiles.has(path)) return {}

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== 'string' || !isPierreDiffs(node.source.value)) return
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue
          if (specifier.imported.type !== 'Identifier') continue
          const name = specifier.imported.name
          if (!guardedImports.has(name) || isTypeOnly(node, specifier)) continue
          context.report({ node: specifier, messageId: 'unnormalizedParse', data: { name } })
        }
      },
    }
  },
})
