<script lang="ts">
  import { ArrowSquareOutIcon, PlusIcon } from "phosphor-svelte";
  import type { TaskLink } from "../../../../shared/task-types";
  import { prStatusBadge } from "../../prs/lib/pr-utils";
  import type { TaskPrRow } from "./lib/task-prs";

  interface Props {
    rows: TaskPrRow[];
    onOpen: (link: TaskLink) => void;
    onOpenExternal: (url: string) => void;
    onUnlink: (link: TaskLink) => void;
    onAdd: () => void;
  }

  let { rows, onOpen, onOpenExternal, onUnlink, onAdd }: Props = $props();
</script>

<!-- Pull requests are the one linked kind with a lifecycle of their own, so
     they get a card of their own rather than a row in the Linked table: state
     is the column that table has nowhere to put. -->
<div class="text-xs flex flex-col gap-[7px] pt-[26px]">
  <div class="flex items-center gap-2.5">
    <span class="text-xs font-normal text-muted-foreground uppercase">
      Pull requests
    </span>
    <span class="tabular-nums text-muted-foreground opacity-70">
      {rows.length}
    </span>
    <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
    <button
      type="button"
      class="flex h-[22px] cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
      onclick={onAdd}
    >
      <PlusIcon size={11} weight="bold" aria-hidden="true" />
      Link PR
    </button>
  </div>

  <div
    class="overflow-hidden rounded-xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
  >
    {#each rows as row, index (row.key)}
      {@const badge = prStatusBadge(row.state)}
      <div
        class="group flex cursor-pointer items-center gap-[11px] py-2 pr-2 pl-[13px] transition-colors hover:bg-[var(--wash-1)] {index
          ? 'border-t-[.5px] border-[var(--hairline)]'
          : ''}"
        role="button"
        tabindex="0"
        title="Open {row.ref} in Solus"
        onclick={() => onOpen(row.link)}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(row.link);
          }
        }}
      >
        <span
          class="flex size-3.5 shrink-0 items-center justify-center"
          style="color:{badge?.tone ?? 'var(--muted-foreground)'}"
          aria-hidden="true"
        >
          {#if badge}
            {@const StateIcon = badge.Icon}
            <StateIcon size={13} />
          {/if}
        </span>
        <span class="flex h-5 shrink-0 items-center tabular-nums text-muted-foreground opacity-65">
          {row.ref}
        </span>
        <span class="flex h-5 min-w-0 flex-1 items-center truncate text-workspace-chrome font-normal">
          {row.title}
        </span>

        <!-- No badge means no client has read this PR's state yet. Say nothing
             rather than render a state we would be inventing. -->
        {#if badge}
          <span
            class="flex h-5 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 font-medium whitespace-nowrap"
            style="color:{badge.tone};background:color-mix(in oklch, {badge.tone} 12%, transparent);box-shadow:0 0 0 .5px color-mix(in oklch, {badge.tone} 30%, transparent)"
          >
            <span
              class="size-[5px] shrink-0 rounded-full"
              style="background:{badge.tone}"
              aria-hidden="true"
            ></span>
            {badge.label}
          </span>
        {/if}

        {#if row.url}
          {@const url = row.url}
          <button
            type="button"
            class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
            onclick={(e) => {
              e.stopPropagation();
              onOpenExternal(url);
            }}
            title="Open {row.ref} in the browser"
            aria-label="Open {row.ref} in the browser"
          >
            <ArrowSquareOutIcon size={13} />
          </button>
        {/if}
        <button
          type="button"
          class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 hover:bg-[var(--wash-2)] hover:text-foreground"
          onclick={(e) => {
            e.stopPropagation();
            onUnlink(row.link);
          }}
          title="Unlink {row.ref}"
          aria-label="Unlink {row.ref}"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            aria-hidden="true"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" /></svg
          >
        </button>
      </div>
    {/each}
  </div>
</div>
