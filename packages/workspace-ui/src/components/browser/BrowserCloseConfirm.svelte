<script lang="ts">
  import { Bot } from "@lucide/svelte";
  import type { BrowserAgentUse } from "@solus/contracts/browser-types";
  import { Button } from "../ui/button";
  import { agentUseSentence } from "./lib/agent-use";

  /** The question the host asked when it refused to close a page an agent is
   *  working in (ADR 0024). */

  interface Props {
    pageLabel: string;
    use: BrowserAgentUse;
    onCancel: () => void;
    onConfirm: () => void;
  }

  let { pageLabel, use, onCancel, onConfirm }: Props = $props();
</script>

<!-- Escape belongs on the dialog itself: the pane below is a browser guest, and
     a key pressed over it never reaches the workspace. -->
<div
  class="absolute inset-0 z-20 flex items-center justify-center bg-[color-mix(in_oklch,var(--solus-container-bg)_72%,transparent)] p-4"
  role="presentation"
  onkeydown={(event) => {
    if (event.key === "Escape") onCancel();
  }}
>
  <div
    class="text-workspace-chrome flex w-[min(22rem,100%)] flex-col gap-2.5 rounded-[14px] bg-[var(--popover)] p-3.5 shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0.5rem_1rem_-0.5rem_rgba(0,0,0,0.18),0_2rem_3rem_-1.5rem_rgba(0,0,0,0.34)]"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="browser-close-confirm-title"
    aria-describedby="browser-close-confirm-body"
  >
    <div class="flex items-center gap-2">
      <span
        class="flex size-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--warning)_16%,transparent)] text-[var(--warning)]"
      >
        <Bot class="size-3.5" aria-hidden="true" />
      </span>
      <span
        id="browser-close-confirm-title"
        class="min-w-0 truncate font-medium text-(--solus-text-primary)"
      >
        Close {pageLabel}?
      </span>
    </div>

    <p id="browser-close-confirm-body" class="text-(--solus-text-secondary)">
      {agentUseSentence(use)} Closing this page ends what it is doing.
    </p>

    <div class="flex items-center justify-end gap-1.5 pt-0.5">
      <!-- Cancel takes the focus, because the safe answer is the one a user who
           pressed Return without reading should get. -->
      <!-- svelte-ignore a11y_autofocus -->
      <Button variant="ghost" size="sm" autofocus onclick={onCancel}>
        Keep it open
      </Button>
      <Button variant="destructive" size="sm" onclick={onConfirm}>
        Close anyway
      </Button>
    </div>
  </div>
</div>
