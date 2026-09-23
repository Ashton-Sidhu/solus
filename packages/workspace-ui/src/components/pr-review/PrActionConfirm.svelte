<script lang="ts">
  import { AlertDialog } from "bits-ui";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";

  // The question a pull request action asks before it does something the host
  // cannot take back on its own: a merge that may land at once, a new pull
  // request that reverses a merged one.
  let {
    open = $bindable(false),
    title,
    description,
    confirmLabel,
    onConfirm,
  }: {
    open?: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
  } = $props();
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Portal>
    <AlertDialog.Overlay
      class="fixed inset-0 z-50 bg-[color-mix(in_oklch,var(--solus-container-bg)_72%,transparent)]"
    />
    <AlertDialog.Content
      class="text-workspace-chrome fixed top-1/2 left-1/2 z-50 flex w-[min(22rem,calc(100vw-2rem))] -translate-1/2 flex-col gap-2.5 rounded-[14px] bg-[var(--popover)] p-3.5 shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0.5rem_1rem_-0.5rem_rgba(0,0,0,0.18),0_2rem_3rem_-1.5rem_rgba(0,0,0,0.34)]"
      onCloseAutoFocus={(event) => {
        // Back to the prompt, not the ⋯ that opened the menu: the next thing
        // is usually typing.
        event.preventDefault();
        requestInputFocus();
      }}
    >
      <AlertDialog.Title class="font-medium text-(--solus-text-primary)">
        {title}
      </AlertDialog.Title>
      <AlertDialog.Description class="text-(--solus-text-secondary)">
        {description}
      </AlertDialog.Description>
      <div class="flex items-center justify-end gap-1.5 pt-0.5">
        <AlertDialog.Cancel>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="sm">Cancel</Button>
          {/snippet}
        </AlertDialog.Cancel>
        <AlertDialog.Action
          onclick={() => {
            open = false;
            onConfirm();
          }}
        >
          {#snippet child({ props })}
            <Button {...props} size="sm">{confirmLabel}</Button>
          {/snippet}
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
