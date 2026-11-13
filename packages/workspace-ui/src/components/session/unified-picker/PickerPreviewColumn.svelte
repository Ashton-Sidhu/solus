<script lang="ts">
  import { onDestroy } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import type { Task, TaskLink } from "@solus/contracts/task-types";
  import type { SessionMeta } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../../contexts";
  import type { SidebarSessionChild } from "../../../contexts/workspace/session-sidebar.store.svelte";
  import { createSessionPreviewStore } from "../../../lib/preview.svelte";
  import { boundHitWindow } from "../../../lib/sessionPreviewMessages";
  import type { PickerEntry as PreviewSource } from "../../../lib/sessionUtils";
  import { relativeTime } from "../../tasks/lib/tasks-api";
  import SessionPreview from "../SessionPreview.svelte";
  import PickerActionBar from "./PickerActionBar.svelte";
  import PickerPreviewSkeleton from "./PickerPreviewSkeleton.svelte";
  import PickerRecordPreview from "./PickerRecordPreview.svelte";
  import TaskPreviewPane from "./TaskPreviewPane.svelte";
  import { entryOpenLabel, hasActionBar } from "./lib/picker-record-view";
  import {
    conversationProjectLabel,
    conversationTitle,
    pickerSessionActivity,
    previewHitTarget,
    type PickerEntry,
  } from "./lib/picker-rows";

  /**
   * The preview of the row the cursor is on, and at its foot the row's actions.
   * The preview scrolls; the action bar floats under it and does not, so what
   * you can do to the row is always one reach away however long its body runs.
   */
  interface Props {
    entry: PickerEntry | null;
    /** The list has no row yet and its reads are in flight. */
    loading: boolean;
    query: string;
    sessionsFor: (task: Task) => SidebarSessionChild[];
    /** Where the dropdowns portal, so they paint above the search's scrim. */
    portalTarget: HTMLElement | null;
    /** ⏎ on the row: the primary button makes the same move. */
    onActivate: (entry: PickerEntry) => void;
    onSelectSession: (session: SidebarSessionChild) => void;
    onSelectTask: (task: Task) => void;
    onStartDraft: (task: Task) => void;
    onOpenTaskPage: (task: Task) => void;
    onOpenSource: (task: Task) => void;
    onOpenLink: (task: Task, link: TaskLink) => void;
    onOpenExternal: (url: string) => void;
    onUnlink: (link: TaskLink) => void;
  }
  let {
    entry,
    loading,
    query,
    sessionsFor,
    portalTarget,
    onActivate,
    onSelectSession,
    onSelectTask,
    onStartDraft,
    onOpenTaskPage,
    onOpenSource,
    onOpenLink,
    onOpenExternal,
    onUnlink,
  }: Props = $props();

  const session = getWorkspaceContext();
  const preview = createSessionPreviewStore();
  onDestroy(() => preview.reset());

  const sessionEntry = $derived(entry?.kind === "session" || entry?.kind === "conversation" ? entry : null);

  // A session already in a tab previews from its live transcript. A durable
  // one needs its metadata first; that read is made once per session and kept
  // for the visit, so arrowing back over a row costs nothing the second time.
  const sessionMetas = new SvelteMap<string, SessionMeta | null>();
  const metaReadsInFlight = new Set<string>();

  function metaKey(child: SidebarSessionChild): string | null {
    return child.serverId && child.sessionId ? `${child.serverId}:${child.sessionId}` : null;
  }
  /**
   * What a session row's ordinary preview reads from: its live tab when it
   * has one with messages, else its durable metadata once that has been read.
   * Null while the read is in flight — this starts it — or when it failed.
   */
  function previewSourceFor(target: SidebarSessionChild): PreviewSource | null {
    const tabId = target.tabId;
    const tabSession = tabId ? session.sessionFor(tabId) : null;
    // An empty restored tab is not proof that its durable session has no messages.
    if (tabId && tabSession?.messages.length) {
      return { kind: "open", tabId, tab: session.tabs[tabId], session: tabSession };
    }
    const key = metaKey(target);
    if (!key) return null;
    if (!sessionMetas.has(key)) {
      if (!metaReadsInFlight.has(key)) {
        metaReadsInFlight.add(key);
        void readSessionMeta(target.serverId!, target.sessionId!).then((meta) => {
          metaReadsInFlight.delete(key);
          sessionMetas.set(key, meta);
        });
      }
      return null;
    }
    const meta = sessionMetas.get(key);
    return meta ? { kind: "history", meta } : null;
  }

  $effect(() => {
    const shown = sessionEntry;
    if (!shown) {
      preview.reset();
      return;
    }
    const stillSelected = () => sessionEntry === shown;
    // The hit already carries the session's metadata, host stamped.
    const source =
      shown.kind === "conversation"
        ? ({ kind: "history", meta: shown.meta } satisfies PreviewSource)
        : previewSourceFor(shown.session);
    // A row found by its words opens on those words; the session's ends are
    // only the fallback for a passage the index has since dropped.
    const hit = previewHitTarget(shown);
    if (hit) preview.showHit(hit, source, session.ctx, stillSelected);
    else if (source) preview.show(source, session.ctx, stillSelected);
    else preview.reset();
  });

  const previewLoading = $derived.by(() => {
    const shown = sessionEntry;
    if (!shown) return false;
    if (shown.kind === "conversation" || shown.hit) return preview.loading;
    const target = shown.session;
    const tabId = target.tabId;
    const tabSession = tabId && session.tabs[tabId] ? session.sessionFor(tabId) : null;
    if (tabId && tabSession?.messages.length) return preview.loading;
    const key = metaKey(target);
    return preview.loading || (!!key && !sessionMetas.has(key));
  });
  // Bounded against the live query, so the marks follow what is in the box.
  const previewHitWindow = $derived(
    preview.hitWindow ? boundHitWindow(preview.hitWindow, query) : null,
  );
</script>

<div class="flex min-w-0 flex-1 flex-col">
  <div class="min-h-0 flex-1 overflow-hidden">
    {#if entry?.kind === "conversation"}
      <SessionPreview
        preview={preview.snapshot}
        hitWindow={previewHitWindow}
        additionalMatches={entry.additionalMatches}
        loading={previewLoading}
        title={conversationTitle(entry.meta)}
        byline={conversationProjectLabel(entry.meta)}
        timeAgo={relativeTime(pickerSessionActivity(entry))}
        {query}
      />
    {:else if entry?.kind === "session"}
      <!-- Dated by the hit when there is one, as the row is. -->
      <SessionPreview
        preview={preview.snapshot}
        hitWindow={previewHitWindow}
        additionalMatches={entry.additionalMatches}
        loading={previewLoading}
        title={entry.session.label}
        byline={entry.task.title}
        timeAgo={relativeTime(pickerSessionActivity(entry))}
        attention={entry.session.attention}
        {query}
      />
    {:else if entry?.kind === "task"}
      {@const task = entry.task}
      <div class="h-full overflow-y-auto px-6 pt-[22px] pb-4">
        <TaskPreviewPane
          {task}
          sessions={sessionsFor(task)}
          {onSelectSession}
          onOpenLink={(link) => onOpenLink(task, link)}
          {onOpenExternal}
          {onUnlink}
          {query}
        />
      </div>
    {:else if entry?.kind === "record"}
      <div class="h-full overflow-y-auto px-6 pt-[22px] pb-4">
        <PickerRecordPreview record={entry.record} {query} />
      </div>
    {:else if loading}
      <PickerPreviewSkeleton />
    {/if}
  </div>
  {#if entry && hasActionBar(entry)}
    <!-- The row's actions float at the foot of the pane: a bar of the pane's
         own, lifted off it, and not a strip docked across the search. Its
         primary button says what ⏎ does to the row. A row with one action has
         no bar (`hasActionBar`). -->
    <div class="shrink-0 px-2 pt-1 pb-2">
      <div class="rounded-2xl bg-popover p-1.5 shadow-[shadow:var(--elev-lift)]" data-testid="picker-action-bar">
        {#if entry.kind === "session"}
          {@const picked = entry}
          <PickerActionBar
            task={picked.task}
            {portalTarget}
            primaryLabel="Resume"
            onPrimary={() => onActivate(picked)}
            onOpenTask={onOpenTaskPage}
            {onOpenSource}
          />
        {:else if entry.kind === "task"}
          {@const picked = entry.task}
          {@const hasSessions = sessionsFor(picked).length > 0}
          <PickerActionBar
            task={picked}
            {portalTarget}
            primaryLabel={hasSessions ? "Resume latest" : "Open new draft"}
            onPrimary={() => onSelectTask(picked)}
            secondaryLabel={hasSessions ? "New draft" : undefined}
            onSecondary={hasSessions ? () => onStartDraft(picked) : undefined}
            onOpenTask={onOpenTaskPage}
            {onOpenSource}
          />
        {:else if entry.kind === "record" && entry.record.type === "pullRequest"}
          {@const picked = entry}
          {@const pullRequestUrl = entry.record.found.pullRequest.url}
          <PickerActionBar
            task={null}
            {portalTarget}
            primaryLabel={entryOpenLabel(picked)}
            onPrimary={() => onActivate(picked)}
            secondaryLabel="Open in browser"
            onSecondary={() => onOpenExternal(pullRequestUrl)}
            onOpenTask={onOpenTaskPage}
            {onOpenSource}
          />
        {/if}
      </div>
    </div>
  {/if}
</div>
