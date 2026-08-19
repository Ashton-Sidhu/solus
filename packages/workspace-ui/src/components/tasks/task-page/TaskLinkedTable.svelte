<script lang="ts">
  import type { TaskLink, TaskLinkKind } from "@solus/contracts/task-types";
  import { linkedTableLinks, linkFilters, linkRow } from "./lib/task-page";

  interface Props {
    links: TaskLink[];
    onOpen: (link: TaskLink) => void;
    onUnlink: (link: TaskLink) => void;
    onAdd: () => void;
  }

  let { links: allLinks, onOpen, onUnlink, onAdd }: Props = $props();

  /** Pull requests have their own section above this one. */
  const links = $derived(linkedTableLinks(allLinks));

  /** Six rows, then "Show all". Expanding does not collapse again — a user who
   *  asked for the whole list is not asking to hide it a moment later. */
  const CAP = 6;
  let filter = $state<TaskLinkKind | null>(null);
  let expanded = $state(false);

  const filters = $derived(linkFilters(links));
  const rows = $derived(
    links.filter((link) => filter === null || link.kind === filter).map(linkRow),
  );
  const shown = $derived(expanded ? rows : rows.slice(0, CAP));
</script>

<div class="text-xs flex flex-col gap-[7px] pt-[26px]">
  <div class="flex items-center gap-2">
    <span class="text-xs font-normal text-muted-foreground uppercase">
      Linked
    </span>
    <span class="tabular-nums text-muted-foreground opacity-70">
      {links.length}
    </span>
    <span class="h-px w-2.5 bg-[var(--hairline)]" aria-hidden="true"></span>
    {#each filters as item (item.label)}
      {@const active = item.kind === filter}
      <button
        type="button"
        class="flex h-[22px] cursor-pointer items-center gap-[5px] rounded-md px-2 transition-colors hover:text-foreground {active
 ? 'bg-[var(--wash-2)] text-foreground'
 : 'text-muted-foreground'}"
        onclick={() => (filter = item.kind)}
      >
        {item.label}
        <span class="tabular-nums opacity-55">{item.count}</span>
      </button>
    {/each}
    <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
    <button
      type="button"
      class="flex h-[22px] cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
      onclick={onAdd}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        aria-hidden="true"><path d="M7 2.6v8.8M2.6 7h8.8" /></svg
      >
      Link
    </button>
  </div>

  <div class="flex flex-col">
    {#if rows.length}
      <div
        class="flex h-6 items-center gap-[11px] border-b-[.5px] border-[var(--hairline)] px-1"
        aria-hidden="true"
      >
        <span class="w-3.5 shrink-0"></span>
        <span
          class="min-w-0 flex-1 font-normal text-muted-foreground uppercase opacity-75"
        >
          Item
        </span>
        <span
          class="w-[92px] shrink-0 font-normal text-muted-foreground uppercase opacity-75"
        >
          Kind
        </span>
        <span
          class="w-[88px] shrink-0 text-right font-normal text-muted-foreground uppercase opacity-75"
        >
          Status
        </span>
      </div>
      {#each shown as row (row.key)}
        <div
          class="group flex h-[33px] cursor-pointer items-center gap-[11px] border-b-[.5px] border-[color-mix(in_oklch,var(--hairline)_60%,transparent)] px-1 transition-colors hover:bg-[var(--wash-1)]"
          role="button"
          tabindex="0"
          onclick={() => onOpen(row.link)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen(row.link);
            }
          }}
        >
          <span
            class="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground opacity-50"
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
              aria-hidden="true"><path d={row.icon} /></svg
            >
          </span>
          <span class="flex min-w-0 flex-1 items-center gap-2">
            {#if row.ref}
              <span
                class="shrink-0 tabular-nums text-muted-foreground opacity-60"
              >
                {row.ref}
              </span>
            {/if}
            <span class="min-w-0 truncate">{row.label}</span>
          </span>
          <span class="w-[92px] shrink-0 whitespace-nowrap text-muted-foreground opacity-70">
            {row.kindLabel}
          </span>
          <span
            class="flex w-[88px] shrink-0 items-center justify-end gap-1.5 whitespace-nowrap text-muted-foreground opacity-75"
          >
            <span class="truncate">{row.meta}</span>
            <button
              type="button"
              class="flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 hover:bg-[var(--wash-2)] hover:text-foreground"
              onclick={(e) => {
                e.stopPropagation();
                onUnlink(row.link);
              }}
              title="Unlink"
              aria-label="Unlink {row.label}"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                aria-hidden="true"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" /></svg
              >
            </button>
          </span>
        </div>
      {/each}
      {#if rows.length > shown.length}
        <button
          type="button"
          class="flex h-[30px] cursor-pointer items-center px-1 text-muted-foreground hover:text-foreground"
          onclick={() => (expanded = true)}
        >
          Show all {rows.length}
        </button>
      {/if}
    {:else}
      <div class="px-1 py-3.5 text-muted-foreground">
        Nothing linked yet. Attach docs, plans or automations to keep this task's context in one
        place.
      </div>
    {/if}
  </div>
</div>
