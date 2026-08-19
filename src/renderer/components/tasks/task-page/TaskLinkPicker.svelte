<script lang="ts">
  import type { TaskLinkInput, TaskLinkKind } from "../../../../shared/task-types";
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

  $effect(() => {
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
<div class="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" onclick={onClose}>
  <div class="absolute inset-0 bg-black/20" aria-hidden="true"></div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="relative flex max-h-[60vh] w-[460px] flex-col overflow-hidden rounded-2xl bg-popover text-workspace-chrome shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_14%,transparent),0_28px_50px_-18px_rgba(0,0,0,.24)]"
    onclick={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="Link something to this task"
  >
    <input
      bind:this={inputEl}
      bind:value={query}
      class="h-11 shrink-0 border-b border-[var(--hairline)] bg-transparent px-3.5 outline-none placeholder:text-muted-foreground"
      placeholder="Link a doc, plan, automation or PR…"
    />
    <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
      {#each results as group (group.menuKind)}
        <div
          class="px-2 pt-2 pb-1 text-xs font-normal text-muted-foreground uppercase"
        >
          {group.label}
        </div>
        {#each group.items as item (item.id)}
          <button
            type="button"
            class="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 hover:bg-[var(--wash-2)]"
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
            <span class="shrink-0 text-xs text-muted-foreground opacity-70">{item.meta}</span>
          </button>
        {/each}
      {:else}
        <div class="px-2 py-6 text-center text-xs text-muted-foreground">
          {query ? "Nothing matches." : "Nothing to link yet."}
        </div>
      {/each}
    </div>
    <div
      class="flex shrink-0 items-center gap-2 border-t border-[var(--hairline)] px-3.5 py-2 text-xs text-muted-foreground"
    >
      {Object.values(KIND_LABEL).join(" · ")}
      <span class="flex-1"></span>
      <span class="">Esc</span>
    </div>
  </div>
</div>
