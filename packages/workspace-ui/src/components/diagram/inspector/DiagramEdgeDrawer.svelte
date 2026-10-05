<script lang="ts">
  import type { DiagramEdge } from "@solus/contracts/diagram-types";
  import type { PlanComment } from "@solus/contracts/types";
  import { EDGE_INSPECTOR_TABS, type EdgeInspectorTab, type EdgeUpdates } from "../lib/inspector-model";
  import type { DiagramInspector } from "../lib/diagram-inspector.svelte";
  import type { DiagramThreads } from "../lib/diagram-threads.svelte";
  import DiagramEdgeInspector from "./DiagramEdgeInspector.svelte";
  import DiagramInspectorRail from "./DiagramInspectorRail.svelte";

  /**
   * The inspected edge's drawer: the full inspector while it is open, the rail
   * that reopens it while it is collapsed. The shell owns the edge, its
   * threads, and what an edit does; this draws the two states.
   */
  interface Props {
    edge: DiagramEdge & { sourceLabel: string; targetLabel: string };
    inspector: DiagramInspector;
    threads: DiagramThreads;
    edgeThreads: PlanComment[];
    hasUnreadThreads: boolean;
    trunkSiblings: number;
    saveState: string;
    update: EdgeUpdates;
    onReverse: () => void;
    onCollapse: () => void;
    onClose: () => void;
    onDelete: () => void;
  }

  let { edge, inspector, threads, edgeThreads, hasUnreadThreads, trunkSiblings, saveState, update, onReverse, onCollapse, onClose, onDelete }: Props = $props();
</script>

{#if inspector.open}
  <DiagramEdgeInspector
    {edge}
    sourceLabel={edge.sourceLabel}
    targetLabel={edge.targetLabel}
    tab={inspector.edgeTab}
    onTabChange={(tab) => (inspector.edgeTab = tab)}
    {trunkSiblings}
    {saveState}
    autoFocus={inspector.autoFocus}
    {update}
    onOpenEndpoint={(nodeId) => inspector.showNode(nodeId, false)}
    {onReverse}
    {onCollapse}
    {onClose}
    {onDelete}
    threads={edgeThreads}
    diagramThreadCount={threads.counts.total}
    showResolved={threads.showResolved}
    onShowResolvedChange={(show) => threads.setShowResolved(show)}
    onOpenThread={(commentId) => threads.openCard(commentId)}
    onShowAllThreads={() => threads.openPanel(null, false)}
    now={threads.now}
  />
{:else}
  <DiagramInspectorRail
    kindWord="Edge"
    label={edge.label || `${edge.sourceLabel} → ${edge.targetLabel}`}
    tint={edge.color ?? "var(--solus-accent)"}
    tabs={EDGE_INSPECTOR_TABS}
    tab={inspector.edgeTab}
    {hasUnreadThreads}
    onExpand={(name) => {
      if (name) inspector.edgeTab = name as EdgeInspectorTab;
      inspector.open = true;
    }}
  >
    {#snippet tile()}
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3.6 4h4a2 2 0 0 1 2 2v5.4M7.6 9.4l2 2 2-2" />
        <circle cx="3.6" cy="4" r="1.4" />
      </svg>
    {/snippet}
  </DiagramInspectorRail>
{/if}
