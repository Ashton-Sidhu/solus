<script lang="ts">
  import {
    CaretDownIcon,
    CheckIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    GitMergeIcon,
  } from "phosphor-svelte";
  import type { IpcContext, MergeMethod } from "../../../shared/types";
  import { toasts } from "../../lib/toasts";
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
      {#each METHOD_OPTIONS as opt (opt.value)}
        <DropdownMenu.Item
          data-menu-current={method === opt.value ? "" : undefined}
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
              class="truncate text-menu-meta leading-[1.35] text-(--solus-text-tertiary)"
            >
              {opt.hint}
            </span>
          </span>
          {#if method === opt.value}
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
