<script lang="ts">
  import { Dialog } from "bits-ui";
  import { X } from "@lucide/svelte";
  import type { AppShortcutTarget } from "@solus/contracts/app-shortcuts";
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { APP_SHORTCUT_LINK_NOTES, appShortcutLinkPlan, shortcutDeviceOf } from "./lib/app-shortcut-link";

  /**
   * Add app shortcut on a client that cannot write a launcher (the web
   * client; docs/app-shortcuts.md §5): an Open in Solus link that Solus for
   * desktop takes, a download for this computer when nothing opened, and on a
   * phone or a tablet one sentence. As Executor's Install as app dialog.
   */
  interface Props {
    isOpen: boolean;
    target: AppShortcutTarget;
    appName: string;
    hostUrl: string | null;
    accountSubject: string | null;
  }
  let { isOpen = $bindable(), target, appName, hostUrl, accountSubject }: Props = $props();

  const device = shortcutDeviceOf(navigator);
  let contentEl = $state<HTMLElement | null>(null);
  const plan = $derived(appShortcutLinkPlan({ target, appName, hostUrl, accountSubject, device }));
  const download = $derived(plan.downloads[0] ?? null);
  const otherDownloads = $derived(plan.downloads.slice(1));

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => isOpen });
</script>

<Dialog.Root bind:open={isOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[10001] modal-backdrop duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <Dialog.Content
      class="text-workspace-chrome fixed inset-0 z-[10001] m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] flex-col gap-5 overflow-y-auto rounded-2xl bg-(--solus-popover-bg) p-6 shadow-(--solus-popover-shadow) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
      bind:ref={contentEl}
      data-testid="app-shortcut-link-dialog"
      onOpenAutoFocus={(event) => {
        // The link is the next step; without one, the dialog itself takes the keyboard.
        const start = contentEl?.querySelector<HTMLElement>("[data-dialog-start]");
        if (!start) return;
        event.preventDefault();
        start.focus();
      }}
      onCloseAutoFocus={(event) => {
        // Back to the prompt, not the ⋯ that opened the menu: the next thing is usually typing.
        event.preventDefault();
        requestInputFocus();
      }}
    >
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" class="absolute top-4 right-4 text-muted-foreground pointer-coarse:tap-area" aria-label="Close"><X size={16} /></Button>
        {/snippet}
      </Dialog.Close>
      <div class="flex flex-col gap-1 pr-8">
        <Dialog.Title class="font-medium text-foreground">Add an app shortcut for {appName}</Dialog.Title>
        <Dialog.Description class="text-pretty text-(--solus-text-secondary)">
          {#if plan.note === "handheld" || plan.note === "other-system"}
            {APP_SHORTCUT_LINK_NOTES[plan.note]}
          {:else}
            In Solus for desktop, {appName} shows where your computer lists apps, and opens in its own window.
          {/if}
        </Dialog.Description>
      </div>
      {#if plan.note === "host-not-shared"}
        <p class="text-pretty text-(--solus-text-tertiary)" role="status">{APP_SHORTCUT_LINK_NOTES[plan.note]}</p>
      {/if}
      {#if plan.link}
        <div class="flex flex-col items-start gap-2">
          <Button href={plan.link} data-dialog-start data-testid="app-shortcut-link-open">Open in Solus</Button>
          {#if download}
            <p class="text-(--solus-text-tertiary)">
              Nothing opened?
              <a class="underline underline-offset-2 hover:text-(--solus-text-primary)" href={download.url} target="_blank" rel="noopener noreferrer">Download Solus</a>
            </p>
          {/if}
        </div>
      {:else if download}
        <div class="flex flex-col items-start gap-2">
          <Button href={download.url} target="_blank" rel="noopener noreferrer" data-dialog-start>{download.label}</Button>
        </div>
      {/if}
      {#if otherDownloads.length > 0}
        <p class="flex flex-wrap gap-x-3 gap-y-1 text-(--solus-text-tertiary)">
          {#each otherDownloads as other (other.system)}
            <a class="underline underline-offset-2 hover:text-(--solus-text-primary)" href={other.url} target="_blank" rel="noopener noreferrer">{other.label}</a>
          {/each}
        </p>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
