<script lang="ts">
  import { tick } from "svelte";
  import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    LayoutTemplate as ArtifactIcon,
    PanelRightClose as OpenInPaneIcon,
  } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import { Button } from "../ui/button";
  import ArtifactRevisionRender from "./ArtifactRevisionRender.svelte";
  import { getArtifactRevisions } from "./lib/artifact-revisions-context";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import {
    artifactGroupSummary,
    artifactGroupTabs,
    lastWrittenWorkId,
    latestVersion,
    nextTabIndex,
    revisionVersion,
    wasCreatedInTurn,
    writeVersion,
    type ArtifactGroupTab,
  } from "./lib/artifact-group";
  import { getSurfaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";

  /**
   * The saved HTML works of one turn that wrote two or more: a line with one
   * tab for each work, and the render of the selected one. No card shell: the
   * render is the only box. What the reader chose (the tab, the version, the
   * fold) lives in the transcript disclosure, so it survives a tab switch.
   */
  let { messages }: { messages: Message[] } = $props();
  const id = $props.id();
  const surface = getSurfaceContext();
  const revisionIndex = getArtifactRevisions();
  const disclosures = getTranscriptDisclosure();
  // `openedByUser` is the fold (null: open), `pickedId` the selected work.
  const view = $derived(disclosures.forKey(`artifact-group:${messages[0].id}`));
  const isOpen = $derived(view.openedByUser ?? true);
  const tabs = $derived(artifactGroupTabs(messages));
  const chainOf = (workId: string) => revisionIndex?.().get(`work:${workId}`) ?? [];
  const selectedTab = $derived(
    tabs.find((tab) => tab.workId === (view.pickedId ?? lastWrittenWorkId(messages))) ?? tabs[tabs.length - 1],
  );
  const selectedIndex = $derived(tabs.indexOf(selectedTab));
  const chain = $derived(chainOf(selectedTab.workId));
  // `pickedId` here is the revision the reader stepped to in this work's chain.
  const versionView = $derived(disclosures.forKey(`artifact-group:${messages[0].id}:${selectedTab.workId}`));
  const shown = $derived(chain.find((revision) => revision.messageId === (versionView.pickedId ?? selectedTab.message.id)));
  const shownIndex = $derived(shown ? chain.indexOf(shown) : -1);
  const latest = $derived(chain[chain.length - 1]);
  const isUpdating = $derived(!shown && !!selectedTab.message.artifact?.streaming);
  const summary = $derived(artifactGroupSummary(tabs, (tab) => wasCreatedInTurn(tab, chainOf(tab.workId))));
  const titleOf = (tab: ArtifactGroupTab) =>
    surface.worksStore.get(tab.workId)?.title ?? tab.message.workRef?.title ?? "Artifact";

  const tabButtons: HTMLButtonElement[] = [];
  let foldButton = $state<HTMLElement | null>(null);
  let openButton = $state<HTMLElement | null>(null);

  function moveTabFocus(event: KeyboardEvent, index: number) {
    const next = nextTabIndex(index, event.key, tabs.length);
    if (next === null) return;
    event.preventDefault();
    tabButtons[next]?.focus();
  }

  // A key press keeps focus on the line that replaced the control; a click
  // returns it to the prompt.
  async function setOpen(event: MouseEvent, open: boolean) {
    view.openedByUser = open;
    if (event.detail !== 0) return requestInputFocus();
    await tick();
    (open ? foldButton : openButton)?.focus();
  }

  function openInPane() {
    surface.openWork(selectedTab.workId);
    requestInputFocus();
  }
</script>

<div class="my-2 min-w-0" data-testid="artifact-group">
  {#if isOpen}
    <div class="mb-2 flex min-w-0 items-center gap-1.5">
      <span class="inline-flex w-5.5 shrink-0 justify-center text-primary"><ArtifactIcon size={13} /></span>
      <div
        role="tablist"
        aria-label="Artifacts"
        class="flex min-w-0 gap-0.5 overflow-x-auto rounded-full bg-(--muted) p-[3px] [scrollbar-width:none]"
      >
        {#each tabs as tab, index (tab.workId)}
          {@const isSelected = tab === selectedTab}
          {@const version = writeVersion(chainOf(tab.workId), tab.message)}
          <button
            bind:this={tabButtons[index]}
            type="button"
            role="tab"
            id="{id}-tab-{index}"
            aria-selected={isSelected}
            aria-controls="{id}-panel"
            tabindex={isSelected ? 0 : -1}
            title={titleOf(tab)}
            class="inline-flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-full px-2.75 text-workspace-chrome whitespace-nowrap transition-[color,background-color,box-shadow] duration-(--duration-quick) ease-(--ease-premium) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border-medium) motion-reduce:transition-none pointer-coarse:h-9.5 pointer-coarse:px-3.25 {isSelected
              ? 'bg-(--card) font-medium text-(--solus-text-primary) shadow-[0_1px_2px_rgb(0_0_0/0.08),0_2px_8px_-2px_rgb(0_0_0/0.1)]'
              : 'text-(--muted-foreground) hover:text-(--solus-text-primary)'}"
            onclick={() => (view.pickedId = tab.workId)}
            onkeydown={(event) => moveTabFocus(event, index)}
          >
            <span class="max-w-[150px] truncate">{titleOf(tab)}</span>
            {#if version}<span class="font-mono text-[11px] tabular-nums opacity-75">v{version}</span>{/if}
          </button>
        {/each}
      </div>
      <span class="flex-1"></span>
      <Button
        variant="ghost"
        size="icon-sm"
        class="size-6.5 shrink-0 rounded-full text-(--muted-foreground) pointer-coarse:tap-area"
        aria-label="Open in the pane"
        title="Open in the pane"
        data-testid="artifact-group-open"
        onclick={openInPane}
      ><OpenInPaneIcon size={14} /></Button>
      <Button
        bind:ref={foldButton}
        variant="ghost"
        size="icon-sm"
        class="size-6.5 shrink-0 rounded-full text-(--muted-foreground) pointer-coarse:tap-area"
        aria-label="Fold the artifacts"
        aria-expanded="true"
        title="Fold"
        onclick={(event: MouseEvent) => setOpen(event, false)}
      ><ChevronDown size={14} /></Button>
    </div>
    <div
      role="tabpanel"
      id="{id}-panel"
      aria-labelledby="{id}-tab-{selectedIndex}"
      class="group/render relative min-w-0"
    >
      {#if shown || isUpdating}
        <!-- The version pill floats in the render's corner. With a fine
             pointer it shows while the pointer or focus is on the render. -->
        <div
          class="absolute top-2.5 right-2.5 z-10 flex items-center gap-0.5 rounded-full border border-(--border) bg-(--popover) py-0.5 pr-1 pl-2.5 opacity-0 shadow-[0_4px_16px_-4px_rgb(0_0_0/0.18)] transition-opacity duration-(--duration-quick) ease-(--ease-premium) group-hover/render:opacity-100 group-focus-within/render:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100"
          data-testid="artifact-group-version"
        >
          <span class="mr-0.5 py-1 font-mono text-[11px] tabular-nums text-(--muted-foreground)">
            {#if shown}
              v{revisionVersion(chain, shownIndex)} of {latestVersion(chain)}
            {:else}
              v{latestVersion(chain) + 1} · updating…
            {/if}
          </span>
          {#if shown && shown !== latest}
            <Button
              variant="ghost"
              size="sm"
              class="h-6 rounded-full px-2 text-transcript-meta pointer-coarse:h-9"
              onclick={() => (versionView.pickedId = latest.messageId)}
            >Latest</Button>
          {/if}
          {#if shown && chain.length > 1}
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-6 rounded-full pointer-coarse:size-9"
              aria-label="Previous version"
              title="Previous version"
              disabled={shownIndex === 0}
              onclick={() => (versionView.pickedId = chain[shownIndex - 1].messageId)}
            ><ChevronLeft size={14} /></Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-6 rounded-full pointer-coarse:size-9"
              aria-label="Next version"
              title="Next version"
              disabled={shown === latest}
              onclick={() => (versionView.pickedId = chain[shownIndex + 1].messageId)}
            ><ChevronRight size={14} /></Button>
          {/if}
        </div>
      {/if}
      {#if shown}
        <ArtifactRevisionRender revision={shown} showRail={false} />
      {:else if selectedTab.message.artifact}
        <ArtifactView artifact={selectedTab.message.artifact} skipMotion />
      {/if}
    </div>
  {:else}
    <button
      bind:this={openButton}
      type="button"
      class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md text-left text-workspace-chrome focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-12"
      aria-expanded="false"
      data-testid="artifact-group-folded"
      onclick={(event) => setOpen(event, true)}
    >
      <span class="inline-flex w-5.5 shrink-0 justify-center text-primary"><ArtifactIcon size={13} /></span>
      <span class="shrink-0 font-medium text-(--solus-text-primary)">{summary.count}</span>
      <span class="min-w-0 truncate text-(--muted-foreground)">{summary.detail}</span>
      <ChevronDown size={14} class="shrink-0 -rotate-90 text-(--muted-foreground)" />
    </button>
  {/if}
</div>
