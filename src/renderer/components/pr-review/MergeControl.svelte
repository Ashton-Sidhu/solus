<script lang="ts">
  import {
    CaretDownIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    GitMergeIcon,
  } from "phosphor-svelte";
  import type { IpcContext, MergeMethod } from "../../../shared/types";
  import { toasts } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";

  // The parent decides visibility: open, non-draft, non-conflicting PRs only.
  // This control maps directly to the code host's individual merge operation.
  let {
    pr,
    getCtx,
  }: {
    pr: { number: number; title: string };
    getCtx: () => IpcContext;
  } = $props();

  let method = $state<MergeMethod>("merge");
  let menuOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let merging = $state(false);
  let merged = $state(false);

  const METHOD_OPTIONS: {
    value: MergeMethod;
    action: string;
    label: string;
    hint: string;
  }[] = [
    {
      value: "merge",
      action: "Merge pull request",
      label: "Merge commit",
      hint: "Keep every commit, plus a merge commit.",
    },
    {
      value: "squash",
      action: "Squash and merge",
      label: "Squash",
      hint: "Combine everything into one commit.",
    },
    {
      value: "rebase",
      action: "Rebase and merge",
      label: "Rebase",
      hint: "Replay each commit onto the base branch.",
    },
  ];
  const actionLabel = $derived(
    METHOD_OPTIONS.find((o) => o.value === method)?.action ?? "",
  );

  async function merge() {
    if (merging || merged) return;
    merging = true;
    menuOpen = false;
    try {
      const result = await window.solus.prMerge(getCtx(), pr.number, method);
      if (!result.merged) {
        toasts.error(result.message ?? "The code host refused the merge.");
        return;
      }
      merged = true;
    } catch (err) {
      toasts.error(
        `Couldn't merge the pull request: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      merging = false;
      requestInputFocus();
    }
  }
</script>

{#if merged}
  <div
    class="flex h-7 items-center gap-1.5 text-[0.75rem] font-medium text-(--solus-art-positive)"
  >
    <CheckCircleIcon size={13} weight="fill" class="shrink-0" />
    Merged
  </div>
{:else}
  <div
    class="flex h-8 w-full items-stretch overflow-hidden rounded-lg bg-(--solus-accent) shadow-[0_1px_2px_color-mix(in_srgb,var(--solus-accent)_22%,transparent)]"
  >
    <Button
      type="button"
      class="inline-flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 border-0 bg-transparent pr-3 pl-3.5 text-[0.8125rem] font-semibold text-(--solus-on-accent,#fff) transition-[background-color,scale] duration-150 hover:bg-white/10 active:scale-[0.98] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={merging}
      onclick={merge}
    >
      {#if merging}
        <CircleNotchIcon size={13} class="shrink-0 animate-spin [animation-duration:0.9s]" />
      {:else}
        <GitMergeIcon size={13} weight="bold" class="shrink-0" />
      {/if}
      <span class="truncate">
        {merging ? "Merging…" : actionLabel}
      </span>
    </Button>
    <span class="my-1 w-px shrink-0 bg-white/30" aria-hidden="true"></span>
    <Button
      type="button"
      bind:ref={triggerEl}
      class="inline-flex cursor-pointer items-center border-0 bg-transparent px-2 text-(--solus-on-accent,#fff) transition-[background-color,scale] duration-100 hover:bg-white/10 active:scale-[0.96] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={merging}
      aria-label="Merge method"
      onclick={() => (menuOpen = !menuOpen)}
    >
      <CaretDownIcon size={11} weight="bold" class="shrink-0" />
    </Button>
  </div>
  <DropdownMenu.Root bind:open={menuOpen}>
    <DropdownMenu.Content customAnchor={triggerEl} side="top" align="end" sideOffset={6} class="w-[220px]">
    <div class="py-1" role="listbox" aria-label="Merge method">
      {#each METHOD_OPTIONS as opt (opt.value)}
        <DropdownMenu.Item
          class={method === opt.value ? "font-semibold" : undefined}
          onSelect={() => {
            method = opt.value;
            menuOpen = false;
          }}
        >
          <div class="flex min-w-0 flex-col gap-0.5 py-0.5">
            <div class="text-[0.6875rem] text-(--solus-text-primary)">
              {opt.label}
            </div>
            <div class="text-[0.625rem] leading-3.5 text-(--solus-text-tertiary)">
              {opt.hint}
            </div>
          </div>
        </DropdownMenu.Item>
      {/each}
    </div>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
