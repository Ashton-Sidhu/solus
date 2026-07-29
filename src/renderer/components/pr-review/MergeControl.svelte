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
    class="flex h-[34px] items-center gap-1.5 text-[13px] font-medium text-(--solus-art-positive)"
  >
    <CheckCircleIcon size={14} weight="fill" class="shrink-0" />
    Merged
  </div>
{:else}
  <div
    class="flex h-[34px] w-full items-stretch overflow-hidden rounded-lg bg-primary"
  >
    <Button
      type="button"
      class="inline-flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 border-0 bg-transparent px-3.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary-foreground/10 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={merging}
      onclick={merge}
    >
      {#if merging}
        <CircleNotchIcon size={13} class="shrink-0 animate-spin [animation-duration:0.9s]" />
      {:else}
        <GitMergeIcon size={13} class="shrink-0" />
      {/if}
      <span class="truncate">
        {merging ? "Merging…" : actionLabel}
      </span>
    </Button>
    <span class="my-1 w-px shrink-0 bg-primary-foreground/25" aria-hidden="true"></span>
    <Button
      type="button"
      bind:ref={triggerEl}
      class="inline-flex w-[30px] shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent px-0 text-primary-foreground transition-colors hover:bg-primary-foreground/10 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={merging}
      aria-label="Merge method"
      onclick={() => (menuOpen = !menuOpen)}
    >
      <CaretDownIcon size={11} class="shrink-0" />
    </Button>
  </div>
  <DropdownMenu.Root bind:open={menuOpen}>
    <DropdownMenu.Content customAnchor={triggerEl} side="top" align="end" sideOffset={6} class="w-[220px]">
    <div class="py-1" role="listbox" aria-label="Merge method">
      {#each METHOD_OPTIONS as opt (opt.value)}
        <DropdownMenu.Item
          class={method === opt.value ? "font-medium" : undefined}
          onSelect={() => {
            method = opt.value;
            menuOpen = false;
          }}
        >
          <div class="flex min-w-0 flex-col gap-0.5 py-0.5">
            <div class="text-[12px] font-medium">
              {opt.label}
            </div>
            <div class="text-[11px] leading-[1.5] text-muted-foreground">
              {opt.hint}
            </div>
          </div>
        </DropdownMenu.Item>
      {/each}
    </div>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
