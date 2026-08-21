<script lang="ts">
  import { onMount } from "svelte";
  import type { TaskLinkInput, TaskLinkKind } from "@solus/contracts/task-types";
  import { getPlanStore, getWorkspaceContext } from "../../../contexts";
  import { ReferenceIndex } from "../../editor/unified-autocomplete/reference-index.svelte";
  import { rank } from "../../editor/unified-autocomplete/rank";
  import type { MenuItem } from "../../editor/unified-autocomplete/rows";

  interface Props {
    projectCwd: string | undefined;
    onPick: (input: TaskLinkInput) => void;
    onClose: () => void;
  }

  let { projectCwd, onPick, onClose }: Props = $props();

  // Same index the `#` autocomplete queries — a picker is just the same
  // categories without a caret in front of them. Sessions are excluded: those
  // are bound through task_session_links, not plain links.
  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const index = new ReferenceIndex({
    session,
    planStore,
    workingDirectory: () => projectCwd,
  });

  const KINDS: { label: string; menuKind: "doc" | "plan" | "automation" | "pr" }[] = [
    { label: "Docs", menuKind: "doc" },
    { label: "Plans", menuKind: "plan" },
    { label: "Automations", menuKind: "automation" },
    { label: "PRs", menuKind: "pr" },
  ];

  let query = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);

  onMount(() => {
    index.warm();
    inputEl?.focus();
  });

  const results = $derived(
    KINDS.map((kind) => ({
      ...kind,
      items: rank(index.byKind[kind.menuKind], query)
        .slice(0, 6)
        .map((ranked) => ranked.item),
    })).filter((group) => group.items.length),
  );

  /** The picker labels a Solus document "Doc"; the wire calls it `work`. This
   *  is the one boundary that translates. */
  function linkFor(item: MenuItem): TaskLinkInput | null {
    const token = item.token;
    switch (token.kind) {
      case "work":
        return { kind: "work", targetKey: token.workId, title: token.title };
      case "plan":
        return {
          kind: "plan",
          targetScope: token.sessionId,
          targetKey: token.planToolUseId,
          title: token.title,
        };
      case "automation":
        return { kind: "automation", targetKey: token.automationId, title: token.title };
      case "pr":
        return {
          kind: "pr",
          targetScope: projectCwd ?? "",
          targetKey: String(token.number),
          title: `#${token.number} ${token.title}`,
        };
      default:
        return null;
    }
  }

  function pick(item: MenuItem) {
    const input = linkFor(item);
    if (input) onPick(input);
    onClose();
  }

  const KIND_LABEL = {
    work: "Doc",
    plan: "Plan",
    automation: "Automation",
    pr: "PR",
  } satisfies Record<TaskLinkKind, string>;
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }}
/>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[12vh] pointer-fine:[.is-laptop-display_&]:pt-[14vh]"
  onclick={onClose}
>
  <div
    class="absolute inset-0 bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)]"
    aria-hidden="true"
  ></div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="relative flex max-h-[min(40rem,68svh)] w-[clamp(28rem,36vw,32rem)] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) text-workspace-chrome shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24)] outline-none pointer-fine:[.is-laptop-display_&]:max-h-[60svh] pointer-fine:[.is-laptop-display_&]:w-[28rem]"
    onclick={(e) => e.stopPropagation()}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Link something to this task"
  >
    <input
      bind:this={inputEl}
      bind:value={query}
      class="h-12 shrink-0 border-b border-[var(--hairline)] bg-transparent px-4 outline-none placeholder:text-muted-foreground pointer-fine:[.is-laptop-display_&]:h-10 pointer-fine:[.is-laptop-display_&]:px-3.5"
      placeholder="Link a doc, plan, automation or PR…"
    />
    <div class="min-h-0 flex-1 overflow-y-auto p-2 pointer-fine:[.is-laptop-display_&]:p-1.5">
      {#each results as group (group.menuKind)}
        <div
          class="px-2.5 pt-2.5 pb-1.5 text-[0.875em] font-normal text-muted-foreground uppercase pointer-fine:[.is-laptop-display_&]:px-2 pointer-fine:[.is-laptop-display_&]:pt-2 pointer-fine:[.is-laptop-display_&]:pb-1"
        >
          {group.label}
        </div>
        {#each group.items as item (item.id)}
          <button
            type="button"
            class="flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 transition-[background-color,scale] duration-120 hover:bg-[var(--wash-2)] active:scale-[0.96] pointer-fine:[.is-laptop-display_&]:h-8 pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-2"
            onclick={() => pick(item)}
          >
            <svg
              width="12.5"
              height="12.5"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="shrink-0 text-muted-foreground opacity-60"
              aria-hidden="true"><path d={item.icon} /></svg
            >
            <span class="min-w-0 flex-1 truncate text-left">{item.title}</span>
            <span class="shrink-0 text-[0.875em] text-muted-foreground opacity-70">{item.meta}</span>
          </button>
        {/each}
      {:else}
        <div class="px-2 py-6 text-center text-[0.875em] text-muted-foreground">
          {query ? "Nothing matches." : "Nothing to link yet."}
        </div>
      {/each}
    </div>
    <div
      class="flex shrink-0 items-center gap-2 border-t border-[var(--hairline)] px-4 py-2.5 text-[0.875em] text-muted-foreground pointer-fine:[.is-laptop-display_&]:px-3.5 pointer-fine:[.is-laptop-display_&]:py-2"
    >
      {Object.values(KIND_LABEL).join(" · ")}
      <span class="flex-1"></span>
      <span class="">Esc</span>
    </div>
  </div>
</div>
