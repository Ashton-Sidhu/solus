<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    Check as CheckIcon,
    LoaderCircle as CircleNotchIcon,
  } from "@lucide/svelte";
  import type { MergeMethod } from "@solus/contracts/types";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { MERGE_METHOD_OPTIONS, defaultMergeMethod } from "./lib/merge-method";
  import type { PrActionsLayout } from "./lib/pr-actions-layout";
  import type { PullRequest } from "../../contexts/prs/pull-request.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";

  // The parent decides visibility: open, non-draft, non-conflicting PRs only.
  // This control maps directly to the code host's individual merge operation.
  let {
    pullRequest,
    methods,
    method = $bindable("merge"),
    onMerged,
    layout = "card",
  }: {
    /** The indexed pull request. It owns the head this merge is checked
     *  against, and indexes whatever the merge makes of it. */
    pullRequest: PullRequest;
    methods: MergeMethod[];
    /** The picked method. Bindable so the rail's footnote can name the merge
     *  this button would actually make instead of guessing one. */
    method?: MergeMethod;
    onMerged?: () => void;
    /** Full-width inside the rail's status card; content-width in the row the
     *  card becomes once the rail folds. */
    layout?: PrActionsLayout;
  } = $props();

  const row = $derived(layout === "row");

  let menuOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let merging = $state(false);
  let merged = $state(false);

  const availableOptions = $derived(
    MERGE_METHOD_OPTIONS.filter((option) => methods.includes(option.value)),
  );
  const selectedMethod = $derived(
    methods.includes(method) ? method : defaultMergeMethod(methods),
  );
  const actionLabel = $derived(
    availableOptions.find((option) => option.value === selectedMethod)?.action ?? "Merge pull request",
  );

  async function merge() {
    if (merging || merged) return;
    merging = true;
    menuOpen = false;
    try {
      const result = await pullRequest.merge(selectedMethod);
      if (!result.merged) {
        toasts.error(result.message ?? "The code host refused the merge.");
        return;
      }
      merged = true;
      onMerged?.();
    } catch (err) {
      toasts.error("Couldn't merge the pull request", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      merging = false;
      requestInputFocus();
    }
  }
</script>

{#if merged}
  <div
    class="flex items-center font-medium text-(--solus-art-positive) {row
      ? 'h-8 shrink-0 pointer-fine:[.is-laptop-display_&]:h-7'
      : 'h-[34px]'}"
  >
    Merged
  </div>
{:else}
  <div
    class="flex items-stretch overflow-hidden rounded-[10px] bg-primary shadow-[0_1px_2px_-1px_color-mix(in_oklch,var(--primary)_55%,transparent)] transition-[scale] duration-150 active:scale-[0.985] {row
      ? 'h-8 shrink-0 pointer-fine:[.is-laptop-display_&]:h-7'
      : 'h-[34px] w-full'}"
  >
    <Button
      type="button"
      class="inline-flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 border-0 bg-transparent px-3.5 font-medium text-primary-foreground transition-colors hover:bg-primary-foreground/10 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={merging}
      onclick={merge}
    >
      {#if merging}
        <CircleNotchIcon size={14} class="shrink-0 animate-spin [animation-duration:0.9s]" />
      {/if}
      <span class="truncate">
        {merging ? "Merging…" : actionLabel}
      </span>
    </Button>
    {#if availableOptions.length > 1}
      <span class="my-1 w-px shrink-0 bg-primary-foreground/25" aria-hidden="true"></span>
      <Button
        type="button"
        bind:ref={triggerEl}
        class="inline-flex w-[30px] shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent px-0 text-primary-foreground transition-colors hover:bg-primary-foreground/10 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={merging}
        aria-label="Merge method"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <CaretDownIcon
          size={11}
          class="shrink-0 transition-transform duration-150 {menuOpen
            ? 'rotate-180'
            : ''}"
        />
      </Button>
    {/if}
  </div>
  <DropdownMenu.Root bind:open={menuOpen}>
    <DropdownMenu.Content
      customAnchor={triggerEl}
      side="bottom"
      align="end"
      sideOffset={6}
      collisionPadding={8}
      class="w-[280px]"
      aria-label="Merge method"
      onInteractOutside={(event) => {
        if (triggerEl?.contains(event.target as Node)) event.preventDefault();
      }}
    >
      {#each availableOptions as opt (opt.value)}
        <DropdownMenu.Item
          data-menu-current={selectedMethod === opt.value ? "" : undefined}
          class="h-auto min-h-11 items-start gap-2.5 py-2"
          onSelect={() => {
            method = opt.value;
            menuOpen = false;
          }}
        >
          <span class="flex min-w-0 flex-1 flex-col gap-px">
            <span
              class="truncate text-menu leading-[1.25] font-medium text-(--solus-text-primary)"
            >
              {opt.label}
            </span>
            <span
              class="truncate text-xs leading-[1.35] text-(--solus-text-tertiary)"
            >
              {opt.hint}
            </span>
          </span>
          {#if selectedMethod === opt.value}
            <CheckIcon
              size={12}
              class="mt-1 shrink-0 text-(--solus-accent)"
              aria-hidden="true"
            />
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
