// Throwaway harness: mounts the code-intelligence symbol card on its own, with
// a stub host, to isolate the Cmd-click freeze from the diff/editor surfaces.
import { mount } from 'svelte'
import '@solus/workspace-ui/index.css'
import CodeIntelPopover from '@solus/workspace-ui/components/code-intel/CodeIntelPopover.svelte'
import type { CodeIntelReference, CodeIntelSymbolResult } from '@solus/contracts/code-intel'

const params = new URLSearchParams(location.search)
const FIRST_PAGE = Number(params.get('page') ?? 100)
const TOTAL = Number(params.get('total') ?? 2689)

function references(from: number, count: number): CodeIntelReference[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `packages/server/src/generated/file-${from + i}.ts`,
    range: { startLine: 10 + i, startCharacter: 4, endLine: 10 + i, endCharacter: 8 },
    preview: { text: `const value = join(root, name) // reference ${from + i}`, matchStart: 14, matchEnd: 18 },
  }))
}

const answer: CodeIntelSymbolResult = {
  ok: true,
  freshness: 'fresh',
  language: {
    language: 'typescript',
    label: 'TypeScript',
    detected: true,
    toolName: 'scip-typescript',
    toolInstalled: true,
    installCommand: 'npm i -g @sourcegraph/scip-typescript',
    state: 'ready',
    indexedAt: Date.now(),
    documentCount: 1020,
    error: null,
  },
  symbol: {
    symbol: 'pm @types/node 25.5.0 `path.d.ts`/`"node:path"`/path/join().',
    name: 'join',
    kind: 'function',
    language: 'typescript',
    documentation: ['```ts\nfunction join(...paths: string[]): string\n```', 'Join all arguments together.'],
    externalDocumentation: null,
    definition: { path: 'node_modules/@types/node/path.d.ts', range: { startLine: 120, startCharacter: 8, endLine: 120, endCharacter: 12 } },
    references: references(0, FIRST_PAGE),
    referenceCount: TOTAL,
    referenceFileCount: TOTAL,
  },
}

const api = {
  codeIntelSymbolAt: async () => answer,
  codeIntelReferences: async (_ctx: unknown, request: { offset: number }) => {
    const next = request.offset + FIRST_PAGE
    return {
      ok: true as const,
      references: references(request.offset, Math.min(FIRST_PAGE, TOTAL - request.offset)),
      referenceCount: TOTAL,
      nextOffset: next < TOTAL ? next : null,
    }
  },
  codeIntelDocs: async () => ({ ok: false as const, error: 'no docs' }),
}

const anchor = new DOMRect(300, 200, 40, 18)

mount(CodeIntelPopover, {
  target: document.getElementById('app')!,
  props: {
    lookup: {
      serverId: 'probe',
      // The card only ever calls these three methods.
      api: api as never,
      ctx: {} as never,
      root: '/Users/sidhu/solus',
      path: 'packages/server/src/code-intel/code-intel-manager.ts',
      line: 3,
      character: 9,
      token: 'join',
      anchor,
    },
    onNavigate: (path: string, line: number) => console.log('navigate', path, line),
    onClose: () => console.log('close'),
  },
})
