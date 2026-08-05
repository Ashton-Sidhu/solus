<script lang="ts">
  import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, CheckIcon } from "phosphor-svelte";
  import type { PullRequestSummary } from "../../../shared/providers";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Breadcrumb from "../ui/breadcrumb";
  import { prGroups, type PrRowContext } from "../prs/lib/prs-list-view";
  import { statusDotColor } from "./lib/pr-status";

  /**
   * The way back, the way sideways, and where you are — the same breadcrumb
   * grammar as project › task › session.
   *
   * A pull request is a place inside the list, so there is no second copy of the
   * list in a sidebar. The `#411` crumb *is* the switcher: it opens the same
   * rows in the same order as the list you came from, filters and all, so a
   * lateral move never costs a round trip. The stepper beside it says how far
   * through the queue you are, because a review session is a queue.
   */
  let {
    number,
    projectCtx,
    onExit,
  }: {
    number: number;
    /** The *project* scope the review was opened from — sibling pull requests
     *  live there, not in this PR's worktree. */
    projectCtx: () => import("../../../shared/types").IpcContext;
    /** Esc, and the middle crumb — back to the list. */
    onExit: () => void;
  } = $props();

  const session = getWorkspaceContext();
  const store = session.prsStore;

  let menuOpen = $state(false);

  // The list's own order, published by PrsPage. Reading it here rather than
  // re-deriving is what makes "the same order as the list behind it" true by
  // construction instead of by coincidence.
  const order = $derived(store.listOrder);
  const position = $derived(order.indexOf(number) + 1);
  const positionLabel = $derived(
    position > 0 ? `${position} of ${order.length}` : "",
  );

  const rowContext = $derived<PrRowContext>({
    checks: (n) => store.checksFor(n),
    isMine: () => false,
  });

  /** The switcher's rows: the visible list, grouped exactly as the list groups
   *  it, in exactly the order it shows them. */
  const menuGroups = $derived.by(() => {
    const byNumber = new Map(store.items.map((pr) => [pr.number, pr]));
    const ordered = order
      .map((n) => byNumber.get(n))
      .filter((pr): pr is PullRequestSummary => !!pr);
    return prGroups(ordered, rowContext, Date.now());
  });

  /** The leaf crumb carries the same status speck the list row does, so the
   *  band says *which* pull request without spending a word on it. */
  const statusDot = $derived(
    statusDotColor(
      menuGroups.find((g) => g.rows.some((r) => Number(r.key) === number))?.key ?? "",
    ),
  );

  const project = $derived(
    session.router.params("prReview")?.cwd?.split("/").filter(Boolean).pop() ?? "",
  );

  function open(next: number) {
    menuOpen = false;
    if (next === number) return;
    void session.openPrReview(next, store.get(next)?.title, { ctx: projectCtx() });
  }

  function step(delta: number) {
    menuOpen = false;
    session.stepPrReview(delta, projectCtx());
    requestInputFocus();
  }

  const crumbButton =
    "flex h-7 cursor-pointer items-center rounded px-[7px] text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-1)] hover:text-foreground";
  const stepButton =
    "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";
</script>

<div class="relative flex min-w-0 items-center gap-1.5">
  <Breadcrumb.Root aria-label="Location" class="flex min-w-0 shrink items-center">
    <Breadcrumb.List class="min-w-0 flex-nowrap gap-px text-[13px] text-foreground">
      {#if project}
        <Breadcrumb.Item class="shrink-0">
          <Breadcrumb.Link class="{crumbButton} gap-[7px]">
            {#snippet child({ props })}
              <button {...props} type="button" onclick={onExit}>
                <span
                  class="size-4 shrink-0 rounded bg-[color-mix(in_oklch,var(--chart-4)_55%,transparent)]"
                  aria-hidden="true"
                ></span>
                <span class="max-w-[14ch] truncate">{project}</span>
              </button>
            {/snippet}
          </Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator class="px-[3px] text-[13px] opacity-30" />
      {/if}

      <Breadcrumb.Item class="shrink-0">
        <Breadcrumb.Link class={crumbButton}>
          {#snippet child({ props })}
            <button {...props} type="button" onclick={onExit}>Pull requests</button>
          {/snippet}
        </Breadcrumb.Link>
      </Breadcrumb.Item>
      <Breadcrumb.Separator class="px-[3px] text-[13px] opacity-30" />

      <!-- The leaf is the switcher. -->
      <Breadcrumb.Item class="shrink-0">
        <button
          type="button"
          class="flex h-7 cursor-pointer items-center gap-[7px] rounded pr-1.5 pl-2 text-[13px] text-foreground transition-colors duration-150 hover:bg-[var(--wash-1)] {menuOpen
            ? 'bg-[var(--wash-2)]'
            : ''}"
          aria-expanded={menuOpen}
          aria-label="Switch pull request"
          onclick={() => (menuOpen = !menuOpen)}
        >
          <span
            class="size-[7px] shrink-0 rounded-full"
            style="background:{statusDot}"
            aria-hidden="true"
          ></span>
          <span class="font-mono text-[12.5px] tabular-nums">#{number}</span>
          <CaretDownIcon
            size={11}
            class="opacity-45 transition-transform duration-150 {menuOpen ? 'rotate-180' : ''}"
          />
        </button>
      </Breadcrumb.Item>
    </Breadcrumb.List>
  </Breadcrumb.Root>

  <!-- Position, not history: how far through the queue this review is. -->
  <div class="ml-1.5 flex items-center gap-1">
    <button
      type="button"
      class={stepButton}
      title="Previous pull request — K"
      aria-label="Previous pull request"
      disabled={order.length < 2}
      onclick={() => step(-1)}
    >
      <CaretLeftIcon size={11} />
    </button>
    <span
      class="min-w-[44px] text-center font-mono text-[10.5px] tabular-nums text-muted-foreground opacity-75"
    >
      {positionLabel}
    </span>
    <button
      type="button"
      class={stepButton}
      title="Next pull request — J"
      aria-label="Next pull request"
      disabled={order.length < 2}
      onclick={() => step(1)}
    >
      <CaretRightIcon size={11} />
    </button>
  </div>

  {#if menuOpen}
    <!-- Click-away. Fixed rather than absolute so it covers the whole surface,
         not just this band. -->
    <button
      type="button"
      class="fixed inset-0 z-30 cursor-default"
      tabindex="-1"
      aria-label="Close pull request switcher"
      onclick={() => (menuOpen = false)}
    ></button>
    <div
      class="absolute top-[34px] left-0 z-40 w-[430px] rounded-2xl bg-popover p-[5px] shadow-[var(--elev-dropdown)]"
      role="listbox"
      aria-label="Pull requests"
    >
      <div class="max-h-[min(52vh,420px)] overflow-y-auto">
        {#each menuGroups as group (group.key)}
          <div class="flex items-center gap-2 px-[9px] pt-1.5 pb-1">
            <span
              class="text-[9px] font-medium tracking-[.09em] text-muted-foreground uppercase"
              >{group.label}</span
            >
            <span class="h-px flex-1 bg-[var(--hairline)]"></span>
            <span class="font-mono text-[10px] text-muted-foreground opacity-50"
              >{group.rows.length}</span
            >
          </div>
          {#each group.rows as row (row.key)}
            {@const rowNumber = Number(row.key)}
            {@const active = rowNumber === number}
            <button
              type="button"
              role="option"
              aria-selected={active}
              class="flex h-[34px] w-full cursor-pointer items-center gap-[9px] rounded-md px-[9px] transition-colors duration-150 hover:bg-[var(--wash-2)] {active
                ? 'bg-[var(--wash-2)]'
                : ''}"
              onclick={() => open(rowNumber)}
            >
              <span
                class="size-1.5 shrink-0 rounded-full"
                style="background:{statusDotColor(group.key)}"
                aria-hidden="true"
              ></span>
              <span
                class="w-[34px] shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground"
                >{row.ident}</span
              >
              <span
                class="min-w-0 flex-1 truncate text-left text-[13px] tracking-[-.005em] {active
                  ? 'font-medium'
                  : ''}">{row.title}</span
              >
              {#if active}
                <CheckIcon size={12} weight="bold" class="shrink-0 text-primary" />
              {/if}
            </button>
          {/each}
        {/each}
      </div>
      <div
        class="mt-[3px] flex items-center gap-2.5 border-t border-[var(--hairline)] px-[9px] pt-2 pb-[5px]"
      >
        <span class="text-[11px] text-muted-foreground">Same order as the list behind it</span>
        <span class="flex-1"></span>
        <span class="font-mono text-[10px] text-muted-foreground opacity-70">↑↓ move · ⏎ open</span>
      </div>
    </div>
  {/if}
</div>
