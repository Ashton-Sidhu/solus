<script lang="ts">
  import { Camera } from "@lucide/svelte";
  import type { Task } from "@solus/contracts/task-types";
  import type {
    BrowserEvidenceOptions,
    BrowserEvidenceTarget,
  } from "@solus/contracts/browser-types";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as TooltipUI from "../ui/tooltip";
  import { evidenceChoices } from "./lib/evidence-menu";

  /**
   * Take the page's picture, and say where it goes.
   *
   * The capture itself is never the point — a screenshot nobody can find again
   * is the state this replaces. So the action is "attach to…", and the
   * destinations are resolved by the host: the pull request open on this page's
   * branch, or a task in the project it is serving. "Capture only" is the way
   * out for a picture that has no home yet.
   */

  interface Props {
    options: BrowserEvidenceOptions | null;
    tasks: Task[];
    cwd: string | undefined;
    busy: boolean;
    onOpen: () => void;
    onCapture: (target: BrowserEvidenceTarget | undefined) => void;
  }

  let { options, tasks, cwd, busy, onOpen, onCapture }: Props = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);

  const choices = $derived(evidenceChoices(options ?? {}, tasks, cwd));
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props })}
      <span {...props} class="inline-flex shrink-0">
        <button
          bind:this={trigger}
          type="button"
          class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30"
          disabled={busy}
          aria-label="Capture this page as evidence"
          onclick={() => {
            // The destinations are the host's answer and go stale: a pull request may
            // have opened since the pane did. Re-ask every time the menu opens.
            onOpen();
            open = !open;
          }}
        >
          <Camera class="size-3.5" />
        </button>
      </span>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content
    class="z-[10050]"
    side="bottom"
    value="Capture this page — attach it to a task or pull request"
  />
</TooltipUI.Root>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Content
    customAnchor={trigger}
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="max-h-[min(22rem,60vh)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto"
    aria-label="Attach this capture to"
  >
    {#each choices as choice (choice.id)}
      {@const Icon = choice.icon}
      <DropdownMenu.Item
        class="h-auto min-h-9 gap-2.5 py-1.5"
        onSelect={() => {
          open = false;
          onCapture(choice.target);
        }}
      >
        <Icon class="size-3.5 shrink-0 text-(--solus-text-tertiary)" />
        <span class="flex min-w-0 flex-1 flex-col gap-[0.0625rem]">
          <span
            class="text-menu truncate leading-[1.25] font-medium text-(--solus-text-primary)"
            >{choice.label}</span
          >
          {#if choice.detail}
            <span
              class="text-workspace-chrome truncate text-(--solus-text-tertiary)"
              >{choice.detail}</span
            >
          {/if}
        </span>
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
