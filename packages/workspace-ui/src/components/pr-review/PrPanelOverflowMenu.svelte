<script lang="ts">
  import {
    Copy as CopyIcon,
    Ellipsis as DotsThreeIcon,
    ExternalLink as OpenExternalIcon,
    GitCompareArrows as CompareIcon,
    PenLine as RewriteIcon,
    RotateCw as ArrowClockwiseIcon,
  } from "@lucide/svelte";
  import { tick } from "svelte";
  import type { GuideHeaderActions } from "../diff/lib/review-header";
  import { copyText } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as DropdownMenu from "../ui/dropdown-menu";

  /**
   * The pull-request panel's contextual menu — the same object as the local
   * review's, so one band grammar covers both kinds of review.
   *
   * The band above it carries navigation and state, plus the one action taken
   * in the moment — Ask Solus, which opens the session on this pull request's
   * branch. Commands used once a session — copy the branch, refresh it, open
   * its page, rewrite the guide — live here, where they cost the chrome
   * nothing on the tabs that cannot use them.
   *
   * The menu reads in two groups. The pull request's own commands lead: they
   * are true on every tab, so they hold the top rows and never move. Under the
   * divider sit the commands the tab you are on can use, headed by its name.
   */
  let {
    tab,
    onRefresh,
    refreshing,
    onOpenPage,
    guide,
    headRef,
  }: {
    tab: "activity" | "map" | "guide" | "diff";
    onRefresh?: () => void;
    refreshing: boolean;
    /** Open the pull request page on its external host. */
    onOpenPage?: () => void;
    /** Absent where this pull request has no guide to rewrite. */
    guide?: GuideHeaderActions;
    /** The head branch, for the copy row — the one ref you might want to type. */
    headRef?: string;
  } = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  const heading = $derived(
    tab === "map"
      ? "Change map"
      : tab === "guide"
        ? "Walkthrough"
        : tab === "diff"
          ? "Diff view"
          : "Activity",
  );

  const showsGuideRow = $derived(tab === "guide" && !!guide?.present);
  const flagsStale = $derived(showsGuideRow && !!guide?.stale);
  const hasItems = $derived(
    !!headRef || (showsGuideRow && !!guide) || !!onRefresh || !!onOpenPage,
  );

  /**
   * Close the menu, then act. A row here can restructure the workspace under
   * the click that chose it: opening the review's session moves the review to
   * the leading pane and mounts a conversation beside it, which tears down the
   * surface this floating menu is anchored in while `onSelect` is still
   * running. Acting one tick after the menu is gone keeps that teardown out of
   * the handler — the same order every other overflow in the review uses.
   */
  async function runAction(action: () => void): Promise<void> {
    open = false;
    await tick();
    action();
  }

  async function copyBranch(): Promise<void> {
    await copyText(headRef ?? "");
    requestInputFocus();
  }
</script>

{#if hasItems}
  <button
    bind:this={triggerEl}
    type="button"
    class="no-drag pointer-events-auto relative flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {open
      ? 'bg-[var(--wash-3)] text-foreground'
      : 'bg-transparent text-muted-foreground hover:bg-[var(--wash-3)] hover:text-foreground'}"
    aria-label={flagsStale
      ? "More pull request options — new commits since guide"
      : "More pull request options"}
    aria-haspopup="menu"
    aria-expanded={open}
    title={flagsStale ? "New commits since guide" : "More options"}
    onclick={() => (open = !open)}
  >
    <DotsThreeIcon size={15} />
    {#if flagsStale}
      <span
        class="absolute top-[3px] right-[3px] size-[5px] rounded-full bg-primary"
        aria-hidden="true"
      ></span>
    {/if}
  </button>

  <DropdownMenu.Root bind:open>
    <DropdownMenu.Content
      customAnchor={triggerEl}
      side="bottom"
      align="end"
      sideOffset={6}
      class="w-[min(23rem,calc(100vw-2rem))]"
      onInteractOutside={(event) => {
        // The trigger is a custom anchor, so Bits UI otherwise treats its
        // pointer-down as an outside interaction and closes the menu before the
        // button's click can toggle it. Keep the current state until that click.
        if (triggerEl?.contains(event.target as Node)) event.preventDefault();
      }}
    >
      <!-- The permanent group: the ref that names this pull request. True on
         every tab, so it holds the top row and never moves.
         Every label stays on one line — a menu row is a fixed 32px, so a label
         that wraps overflows its own row rather than growing it. -->
      {#if headRef}
        <DropdownMenu.Item
          onSelect={() => void runAction(() => void copyBranch())}
        >
          <CopyIcon size={14} />
          <span class="whitespace-nowrap">Copy branch name</span>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
      {/if}

      <DropdownMenu.Label>{heading}</DropdownMenu.Label>

      {#if showsGuideRow && guide && guide.stale && !guide.regenerating}
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger>
            <CompareIcon size={14} />
            <span class="whitespace-nowrap">New commits since guide</span>
            <span
              class="ml-auto size-[5px] shrink-0 rounded-full bg-primary"
              aria-hidden="true"
            ></span>
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent class="w-auto min-w-52">
            <DropdownMenu.Item
              onSelect={() => void runAction(() => guide.onRegenerate("new-commits"))}
            >
              <CompareIcon size={14} />
              Review new commits only
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => void runAction(() => guide.onRegenerate("full"))}
            >
              <RewriteIcon size={14} />
              Regenerate full guide
            </DropdownMenu.Item>
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
      {:else if showsGuideRow && guide}
        <DropdownMenu.Item
          disabled={guide.regenerating}
          onSelect={() => void runAction(() => guide.onRegenerate("full"))}
        >
          <RewriteIcon size={14} />
          {guide.regenerating ? "Regenerating…" : "Regenerate guide"}
        </DropdownMenu.Item>
      {/if}

      {#if onRefresh}
        <DropdownMenu.Item
          disabled={refreshing}
          onSelect={() => void runAction(onRefresh)}
        >
          <ArrowClockwiseIcon
            size={14}
            class={refreshing ? "animate-spin [animation-duration:0.9s]" : ""}
          />
          {refreshing ? "Refreshing…" : "Refresh pull request"}
        </DropdownMenu.Item>
      {/if}

      {#if onOpenPage}
        <DropdownMenu.Item
          onSelect={() => void runAction(() => onOpenPage?.())}
        >
          <OpenExternalIcon size={14} />
          Open in browser
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
