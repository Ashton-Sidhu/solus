<script lang="ts">
  /** The dialog an Integrations row opens to take a key or a token, in the
   *  shell of `McpConnectDialog`: the logo, a title and one line, then the
   *  form. It opens on the form's first field, not on the close button. */
  import type { Snippet } from "svelte";
  import { Dialog } from "bits-ui";
  import Icon from "@iconify/svelte";
  import { X } from "@lucide/svelte";
  import { Button } from "../ui/button";

  interface Props {
    isOpen: boolean;
    title: string;
    description: string;
    /** An Iconify name from `PROVIDER_LOGOS`. */
    logo: string;
    /** Runs when the person closes the dialog, before it animates out. */
    onClose?: () => void;
    children: Snippet;
    testId?: string;
  }

  let { isOpen = $bindable(), title, description, logo, onClose, children, testId }: Props = $props();
  let contentEl = $state<HTMLElement | null>(null);

  function focusFirstField(event: Event) {
    const field = contentEl?.querySelector<HTMLElement>("form input, form button, [data-dialog-start]");
    if (!field) return;
    event.preventDefault();
    field.focus();
  }
</script>

<Dialog.Root bind:open={isOpen} onOpenChange={(open) => { if (!open) onClose?.(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[10001] modal-backdrop duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <!-- Centred with margins, not a translate, so the zoom of the animation does not fight the position. -->
    <Dialog.Content
      bind:ref={contentEl}
      onOpenAutoFocus={focusFirstField}
      class="text-workspace-chrome fixed inset-0 z-[10001] m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] flex-col gap-5 overflow-y-auto rounded-2xl bg-(--solus-popover-bg) p-6 shadow-(--solus-popover-shadow) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
      data-testid={testId}
    >
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" class="absolute top-4 right-4 text-muted-foreground pointer-coarse:tap-area" aria-label="Close"><X size={16} /></Button>
        {/snippet}
      </Dialog.Close>
      <div class="flex flex-col gap-1 pr-8">
        <span class="mb-3 grid size-8 place-items-center rounded-lg border border-border/50 bg-white text-neutral-900 shadow-xs" aria-hidden="true">
          <Icon icon={logo} width={18} height={18} />
        </span>
        <Dialog.Title class="font-medium text-foreground">{title}</Dialog.Title>
        <Dialog.Description class="text-pretty text-(--solus-text-secondary)">{description}</Dialog.Description>
      </div>
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
