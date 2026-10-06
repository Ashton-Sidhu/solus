<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    Check as CheckIcon,
    LoaderCircle as CircleNotchIcon,
  } from "@lucide/svelte";
  import type { MergeMethod } from "@solus/contracts/types";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { PullRequest } from "../../contexts/prs/pull-request.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PrActionConfirm from "./PrActionConfirm.svelte";
  import { MERGE_METHOD_OPTIONS } from "./lib/merge-method";
  import type { MergeAction, MergeReadiness } from "./lib/merge-readiness";
  import {
    hasPrimaryMenuItems,
    prPrimaryAction,
    prPrimaryMenu,
  } from "./lib/pr-primary-action";

  /**
   * The pull request's number as its one action. The number leads, the move
   * the readiness model chose follows, and the colour is the state the move
   * changes: merge, update the branch, resolve conflicts, auto-merge, mark
   * ready. With no move for this viewer it states where the pull request
   * stands — merged, closed, auto-merge on, checks running — so the number
   * always reads as the pull request's status.
   *
   * The caret beside it holds the other ways to land: the merge method, merge
   * now in place of waiting, and auto-merge on or off. One control in the
   * header and in the status card, so the two can never offer different moves.
   */
  let {
    number,
    pullRequest,
    readiness,
    onAgentAction,
    layout = "header",
  }: {
    number: number;
    /** The indexed pull request; null until the host has described it. */
    pullRequest: PullRequest | null;
    readiness: MergeReadiness | null;
    /** The moves that open a session rather than write to the host. */
    onAgentAction: (move: MergeAction) => Promise<void>;
    /** The page band, the status card's full width, or its folded row. */
    layout?: "header" | "card" | "row";
  } = $props();

  let menuOpen = $state(false);
  let triggerEl = $state<HTMLElement | null>(null);
  let running = $state<MergeAction["kind"] | "merge-now" | "disable-auto-merge" | null>(null);
  // The reader's method for this pull request, once picked from the caret.
  let picked = $state<MergeMethod | null>(null);
  let confirmOpen = $state(false);

  const action = $derived(
    pullRequest && readiness ? prPrimaryAction(pullRequest, readiness, picked) : null,
  );
  const menu = $derived(pullRequest && action ? prPrimaryMenu(pullRequest, action) : null);
  const hasMenu = $derived(!!menu && hasPrimaryMenuItems(menu));
  const filled = $derived(!!action?.move);
  const methodLabel = $derived(
    (MERGE_METHOD_OPTIONS.find((option) => option.value === menu?.method)?.label ?? "Merge commit").toLowerCase(),
  );
  const runningLabel = $derived(
    running === "merge" || running === "merge-now"
      ? "Merging…"
      : running === "update-branch"
        ? "Updating…"
        : "Working…",
  );

  async function write(kind: NonNullable<typeof running>, work: () => Promise<PullRequest | void>, failure: string) {
    if (running) return;
    menuOpen = false;
    running = kind;
    try {
      await work();
    } catch (error) {
      toasts.error(failure, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = null;
      requestInputFocus();
    }
  }

  function runMove(move: MergeAction) {
    const pr = pullRequest;
    if (!pr) return;
    if (move.kind === "merge") void write("merge", () => pr.merge(move.method), "Couldn't merge the pull request");
    else if (move.kind === "enable-auto-merge")
      void write("enable-auto-merge", () => pr.enableAutoMerge(move.method), "Couldn't turn on auto-merge");
    else if (move.kind === "mark-ready")
      void write("mark-ready", () => pr.updateLifecycle("ready", pr.headSha), "Couldn't mark the pull request ready");
    else if (move.kind === "update-branch")
      void write("update-branch", () => pr.updateBranch(), "Couldn't update the branch");
    else void write(move.kind, () => onAgentAction(move), "Couldn't start the pull request action");
  }

  function activate() {
    if (action?.move) runMove(action.move);
    else if (hasMenu) menuOpen = !menuOpen;
  }

  function runConfirmedAutoMerge() {
    const pr = pullRequest;
    const method = menu?.method;
    if (!pr || !method) return;
    void write("enable-auto-merge", () => pr.enableAutoMerge(method), "Couldn't turn on auto-merge");
  }
</script>

<!-- The tone classes are the state, so they are the one choice made here: a
     move is a filled button, a state is a quiet ringed one in its own colour. -->
<div
  bind:this={triggerEl}
  data-testid="pr-primary-action"
  class="flex min-w-0 items-stretch overflow-hidden transition-[scale] duration-150 active:scale-[0.985] {layout === 'header'
    ? 'h-6.5 max-w-[20rem] shrink rounded-full pointer-coarse:h-10'
    : layout === 'row'
      ? 'h-8 shrink-0 rounded-[10px]'
      : 'h-[34px] w-full rounded-[10px]'} {!action
    ? 'text-muted-foreground shadow-[shadow:var(--elev-ring)]'
    : filled && action.tone === 'negative'
      ? 'bg-(--solus-art-negative) text-white'
      : filled
        ? 'bg-primary text-primary-foreground shadow-[0_1px_2px_-1px_color-mix(in_oklch,var(--primary)_55%,transparent)]'
        : action.tone === 'positive'
          ? 'text-(--solus-art-positive) shadow-[shadow:var(--elev-ring)]'
          : action.tone === 'review'
            ? 'bg-[color-mix(in_oklch,var(--review)_12%,transparent)] text-[color-mix(in_oklch,var(--review)_70%,var(--foreground))]'
            : action.tone === 'negative'
              ? 'text-(--solus-art-negative) shadow-[shadow:var(--elev-ring)]'
              : 'text-muted-foreground shadow-[shadow:var(--elev-ring)]'}"
>
  <Button
    type="button"
    variant="ghost"
    class="inline-flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-none border-0 bg-transparent font-medium text-inherit shadow-none hover:bg-[color-mix(in_oklch,currentColor_10%,transparent)] hover:text-inherit disabled:opacity-100 aria-expanded:bg-[color-mix(in_oklch,currentColor_10%,transparent)] {layout === 'header'
      ? 'px-3 text-workspace-chrome pointer-coarse:px-3.5 @max-[40rem]/band:px-2.5'
      : 'px-3.5'} {action?.move || hasMenu ? 'cursor-pointer' : 'cursor-default'}"
    disabled={!!running || !action || (!action.move && !hasMenu)}
    aria-haspopup={!action?.move && hasMenu ? "menu" : undefined}
    aria-expanded={!action?.move && hasMenu ? menuOpen : undefined}
    aria-label={action ? `#${number}: ${action.title}` : `#${number}`}
    title={action?.title}
    onclick={activate}
  >
    {#if running}
      <CircleNotchIcon size={13} class="shrink-0 animate-spin [animation-duration:0.9s]" aria-hidden="true" />
    {/if}
    <!-- The number leads in the header, where it names the pull request. The
         status card sits under the title, so there the button is the move. -->
    {#if layout === "header"}
      <span class="shrink-0 font-mono tabular-nums {filled ? 'opacity-80' : ''}">#{number}</span>
    {/if}
    {#if action}
      <span
        class="min-w-0 truncate {layout === 'header' ? '@max-[40rem]/band:hidden' : ''}"
      >
        {#if layout === "header"}<span class="opacity-45" aria-hidden="true">·</span>{/if}
        {running ? runningLabel : action.label}
      </span>
    {/if}
  </Button>
  {#if hasMenu && action?.move}
    <span class="my-1.5 w-px shrink-0 bg-current opacity-25" aria-hidden="true"></span>
    <Button
      type="button"
      variant="ghost"
      class="inline-flex h-full w-7 shrink-0 cursor-pointer items-center justify-center rounded-none border-0 bg-transparent px-0 text-inherit shadow-none hover:bg-[color-mix(in_oklch,currentColor_10%,transparent)] hover:text-inherit aria-expanded:bg-[color-mix(in_oklch,currentColor_10%,transparent)] pointer-coarse:w-10"
      disabled={!!running}
      aria-label="More ways to merge"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onclick={() => (menuOpen = !menuOpen)}
    >
      <CaretDownIcon
        size={12}
        class="shrink-0 transition-transform duration-150 {menuOpen ? 'rotate-180' : ''}"
        aria-hidden="true"
      />
    </Button>
  {/if}
</div>

{#if menu && hasMenu}
  <DropdownMenu.Root bind:open={menuOpen}>
    <DropdownMenu.Content
      customAnchor={triggerEl}
      side="bottom"
      align="end"
      sideOffset={6}
      collisionPadding={8}
      class="w-[min(18rem,calc(100vw-2rem))] [&_.menu-row]:text-workspace-chrome"
      aria-label="Merge options"
      onInteractOutside={(event) => {
        if (triggerEl?.contains(event.target as Node)) event.preventDefault();
      }}
    >
      {#if menu.methods.length > 0}
        <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">Merge method</DropdownMenu.Label>
        {#each MERGE_METHOD_OPTIONS.filter((option) => menu.methods.includes(option.value)) as option (option.value)}
          <DropdownMenu.Item
            data-menu-current={menu.method === option.value ? "" : undefined}
            class="h-auto min-h-11 items-start gap-2.5 py-2"
            onSelect={() => {
              picked = option.value;
              menuOpen = false;
              requestInputFocus();
            }}
          >
            <span class="flex min-w-0 flex-1 flex-col gap-px">
              <span class="truncate font-medium text-foreground">{option.label}</span>
              <span class="truncate text-xs leading-[1.35] text-muted-foreground">{option.hint}</span>
            </span>
            {#if menu.method === option.value}
              <CheckIcon size={12} class="mt-1 shrink-0 text-(--solus-accent)" aria-hidden="true" />
            {/if}
          </DropdownMenu.Item>
        {/each}
      {/if}
      {#if menu.methods.length > 0 && (menu.mergeNow || menu.enableAutoMerge || menu.disableAutoMerge)}
        <DropdownMenu.Separator />
      {/if}
      {#if menu.mergeNow && pullRequest}
        {@const pr = pullRequest}
        {@const method = menu.method}
        <DropdownMenu.Item
          onSelect={() => void write("merge-now", () => pr.merge(method), "Couldn't merge the pull request")}
        >
          Merge now ({methodLabel})
        </DropdownMenu.Item>
      {/if}
      {#if menu.disableAutoMerge && pullRequest}
        {@const pr = pullRequest}
        <DropdownMenu.Item
          onSelect={() => void write("disable-auto-merge", () => pr.disableAutoMerge(), "Couldn't turn off auto-merge")}
        >
          Turn off auto-merge
        </DropdownMenu.Item>
      {:else if menu.enableAutoMerge}
        <DropdownMenu.Item
          onSelect={() => {
            menuOpen = false;
            confirmOpen = true;
          }}
        >
          Auto-merge when ready ({methodLabel})
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<PrActionConfirm
  bind:open={confirmOpen}
  title="Enable auto-merge?"
  description="This merges #{number} using {methodLabel} as soon as the host considers it ready, which may be immediately."
  confirmLabel="Enable auto-merge"
  onConfirm={runConfirmedAutoMerge}
/>
