<script lang="ts">
  import type { Edge, Node } from "@xyflow/svelte";
  import DiagramThreadCard from "./DiagramThreadCard.svelte";
  import DiagramThreadComposer from "./DiagramThreadComposer.svelte";
  import { anchorRectFor } from "./lib/thread-card-position";
  import type { DiagramThreads } from "./lib/diagram-threads.svelte";

  interface Props {
    threads: DiagramThreads;
    nodes: Node[];
    edges: Edge[];
    /** What the composer's anchor is called. */
    composerLabel: string;
    pane: { width: number; height: number };
    inspectorFootprint: number;
    onCancelComposer: () => void;
  }

  let { threads, nodes, edges, composerLabel, pane, inspectorFootprint, onCancelComposer }: Props = $props();

  const cardAnchorRect = $derived(threads.openThread === null ? null : anchorRectFor(threads.openThread, nodes, edges));
  const composerAnchorRect = $derived(
    threads.composerAnchor === null ? null : anchorRectFor(threads.composerAnchor, nodes, edges),
  );
</script>

<!-- The floating thread surfaces. Mounted inside the flow so they can read the
     viewport and ride their anchor through a pan, without scaling with the
     zoom. The composer and the card share geometry: posting swaps one for the
     other without moving it. -->
{#if threads.composerAnchor}
  <DiagramThreadComposer
    anchorLabel={composerLabel}
    anchorRect={composerAnchorRect}
    {pane}
    {inspectorFootprint}
    onSubmit={(text) => threads.submitComposer(text)}
    onCancel={() => {
      threads.composerAnchor = null;
      onCancelComposer();
    }}
  />
{/if}
{#if threads.openThread}
  {@const openThread = threads.openThread}
  <DiagramThreadCard
    comment={openThread}
    anchorLabel={openThread.selectedText}
    anchorRect={cardAnchorRect}
    {pane}
    {inspectorFootprint}
    now={threads.now}
    editing={threads.editingThreadId === openThread.id}
    onResolve={(resolved) => threads.resolve(openThread.id, resolved)}
    onReply={(text) => threads.reply(openThread.id, text)}
    onStartEdit={() => (threads.editingThreadId = openThread.id)}
    onSaveEdit={(text) => {
      threads.editComment(openThread.id, text);
      threads.editingThreadId = null;
    }}
    onCancelEdit={() => (threads.editingThreadId = null)}
    onDelete={() => {
      threads.deleteComment(openThread.id);
      threads.closeFloating();
    }}
  />
{/if}
