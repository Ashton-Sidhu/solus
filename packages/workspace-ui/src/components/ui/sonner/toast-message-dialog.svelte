<script lang="ts">
  import { Dialog } from "bits-ui";
  import XIcon from "@lucide/svelte/icons/x";
  import { Button } from "../button/index.js";
  import { TerminalOutput } from "../terminal-output/index.js";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toastMessageDialog } from "./toast-message.svelte";

  const message = $derived(toastMessageDialog.message);
</script>

<Dialog.Root
  open={message !== null}
  onOpenChange={(isOpen) => { if (!isOpen) toastMessageDialog.close(); }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 modal-backdrop duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <!-- Centred with margins, not a translate, so the zoom of the animation does not fight the position. -->
    <Dialog.Content
      data-solus-ui
      onCloseAutoFocus={(event) => { event.preventDefault(); requestInputFocus(); }}
      class="no-drag text-workspace-chrome fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] flex-col gap-4 rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) p-6 shadow-(--solus-popover-shadow) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
    >
      {#if message}
        <div class="flex items-start gap-3">
          <Dialog.Title class="min-w-0 flex-1 font-medium text-foreground">{message.title}</Dialog.Title>
          <Dialog.Close>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-sm" class="-mt-1 -mr-2 text-muted-foreground pointer-coarse:size-11" aria-label="Close"><XIcon size={16} /></Button>
            {/snippet}
          </Dialog.Close>
        </div>
        <Dialog.Description class="sr-only">The full message of a notification.</Dialog.Description>
        <!-- A long message is mostly a command's output, so it reads as the
             terminal printed it, with the terminal's own Copy on its corner. -->
        <TerminalOutput output={message.text} label="Full message" class="max-h-[calc(100dvh-10rem)]" />
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
