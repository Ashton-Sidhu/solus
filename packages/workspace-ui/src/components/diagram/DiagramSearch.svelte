<script lang="ts">
  import { Panel, useSvelteFlow } from '@xyflow/svelte'
  import { ChevronUp, ChevronDown, X, Search } from '@lucide/svelte'
  import { Input } from '../ui/input'
  import { searchDiagram, nextSearchIndex, type DiagramSearchResult } from './lib/diagram-search'
  import { flowNodeToDiagram, flowEdgeToDiagram } from './diagram-flow-map'
  interface Props {
    onMatchedChange: (ids: Set<string> | null) => void
    onReveal: (nodeIds: string[]) => Promise<void>
    onClose: () => void
  }
  let { onMatchedChange, onReveal, onClose }: Props = $props()
  const flow = useSvelteFlow()
  let query = $state('')
  let inputEl = $state<HTMLInputElement | null>(null)
  let matches = $state<DiagramSearchResult[]>([])
  let index = $state(-1)
  let navigation = 0
  $effect(() => { inputEl?.focus() })
  function runSearch() {
    navigation++
    matches = searchDiagram({ nodes: flow.getNodes().map(flowNodeToDiagram), edges: flow.getEdges().map(flowEdgeToDiagram) }, query)
    index = -1
    onMatchedChange(query.trim() ? new Set(matches.flatMap(m => m.nodeIds)) : null)
  }
  async function navigate(step: number) {
    if (!matches.length) return
    index = nextSearchIndex(index < 0 && step < 0 ? 0 : index, matches.length, step)
    const match = matches[index], revision = ++navigation
    await onReveal(match.nodeIds)
    if (revision !== navigation) return
    const nodes = match.nodeIds.map(id => flow.getInternalNode(id)).filter(n => n !== undefined)
    if (!nodes.length) { runSearch(); return }
    const left = Math.min(...nodes.map(n => n.internals.positionAbsolute.x))
    const top = Math.min(...nodes.map(n => n.internals.positionAbsolute.y))
    const right = Math.max(...nodes.map(n => n.internals.positionAbsolute.x + (n.measured.width ?? 192)))
    const bottom = Math.max(...nodes.map(n => n.internals.positionAbsolute.y + (n.measured.height ?? 56)))
    await flow.setCenter((left + right) / 2, (top + bottom) / 2, { zoom: flow.getViewport().zoom, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150 })
  }
  function handleKeydown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape') { navigation++; onClose() }
    else if (e.key === 'Enter') { e.preventDefault(); void navigate(e.shiftKey ? -1 : 1) }
  }
</script>
<Panel position="top-left">
  <div class="flex w-[28rem] max-w-[calc(100cqi-2rem)] flex-wrap items-center gap-1 rounded-lg border border-(--solus-container-border) bg-(--solus-container-bg) p-1 text-workspace-chrome text-(--solus-text-secondary)" role="search" aria-label="Search diagram">
    <Search size={16} class="ml-1 shrink-0" />
    <div class="min-w-0 flex-1">
      <Input bind:ref={inputEl} bind:value={query} name="diagram-search" oninput={runSearch} onkeydown={handleKeydown}
        class="min-w-0 border-0 bg-transparent shadow-none max-sm:text-base" placeholder="Nodes, fields, connections…" aria-label="Search nodes, fields and connections" />
    </div>
    <span class="shrink-0 px-1 tabular-nums" aria-live="polite">{query.trim() ? matches.length ? `${index < 0 ? '–' : index + 1} / ${matches.length}` : 'No results' : ''}</span>
    <button type="button" class="canvas-toolbar__btn" disabled={!matches.length} onclick={() => navigate(-1)} aria-label="Previous result" title="Previous result (Shift+Enter)"><ChevronUp size={16} /></button>
    <button type="button" class="canvas-toolbar__btn" disabled={!matches.length} onclick={() => navigate(1)} aria-label="Next result" title="Next result (Enter)"><ChevronDown size={16} /></button>
    <button type="button" class="canvas-toolbar__btn" onclick={onClose} aria-label="Close search" title="Close search (Esc)"><X size={16} /></button>
    {#if matches[index]}
      <span class="w-full truncate px-1 pb-1 text-(--solus-text-tertiary)">{matches[index].kind === 'edge' ? 'Connection' : 'Node'} · {matches[index].label}</span>
    {/if}
  </div>
</Panel>
