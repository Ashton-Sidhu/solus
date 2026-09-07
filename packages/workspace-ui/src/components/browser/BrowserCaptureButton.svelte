<script lang="ts">
  import { Camera } from "@lucide/svelte";
  import type { Task } from "@solus/contracts/task-types";
  import type {
    BrowserEvidenceOptions,
    BrowserEvidenceTarget,
  } from "@solus/contracts/browser-types";
  import * as Popover from "../ui/popover";
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
   *
   * The sheet is the same one the size and profile chips open beside it: one
   * heading, one row per choice, the distinguishing fact trailing in the quiet
   * tone. Three pickers in one toolbar have to read as one instrument.
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
  const destinations = $derived(choices.filter((choice) => choice.target));

  function choose(target: BrowserEvidenceTarget | undefined) {
    open = false;
    onCapture(target);
  }
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props })}
      <span {...props} class="inline-flex shrink-0">
        <button
          bind:this={trigger}
          type="button"
          class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 {open
            ? 'bg-[var(--wash-2)] text-(--solus-text-primary)'
            : ''}"
          disabled={busy}
          aria-label="Capture this page as evidence"
          aria-haspopup="dialog"
          aria-expanded={open}
          onclick={() => {
            // The destinations are the host's answer and go stale: a pull request may
            // have opened since the pane did. Re-ask every time the menu opens.
            if (!open) onOpen();
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

<Popover.Root bind:open>
  <Popover.Content
    customAnchor={trigger}
    side="bottom"
    align="end"
    sideOffset={6}
    class="max-h-[calc(100vh-8rem)] w-[min(18.5rem,calc(100vw-2rem))] overflow-y-auto p-1.5"
    aria-label="Capture this page"
  >
    <div class="text-workspace-chrome">
      <div
        class="px-2 pt-1 pb-1.5 font-medium tracking-widest text-(--solus-text-tertiary) uppercase"
      >
        Capture
      </div>

      <button
        type="button"
        class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-[var(--wash-2)]"
        onclick={() => choose(undefined)}
      >
        <Camera class="size-3.5 shrink-0 text-(--solus-text-tertiary)" />
        <span class="flex-1 text-(--solus-text-primary)">Capture only</span>
      </button>

      {#if destinations.length}
        <div class="px-2 pt-2 pb-1 text-(--solus-text-tertiary)">Attach to</div>
        {#each destinations as choice (choice.id)}
          {@const Icon = choice.icon}
          <button
            type="button"
            class="flex h-8 w-full items-center gap-2.5 overflow-hidden rounded-md px-2 text-left transition-colors hover:bg-[var(--wash-2)]"
            onclick={() => choose(choice.target)}
          >
            <Icon class="size-3.5 shrink-0 text-(--solus-text-tertiary)" />
            <span class="min-w-0 flex-1 truncate text-(--solus-text-primary)"
              >{choice.label}</span
            >
            {#if choice.detail}
              <span
                class="max-w-[45%] shrink-0 truncate text-(--solus-text-tertiary)"
                >{choice.detail}</span
              >
            {/if}
          </button>
        {/each}
      {:else}
        <!-- An empty destination list is a fact about this page, and saying so
             beats a menu with one row and no explanation. -->
        <p class="px-2 pt-1.5 pb-1 text-(--solus-text-tertiary)">
          No open task or pull request for this page.
        </p>
      {/if}
    </div>
  </Popover.Content>
</Popover.Root>
