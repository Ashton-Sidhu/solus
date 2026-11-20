<script lang="ts">
  import { untrack } from "svelte";
  import { settingsSectionLoaders } from "./lib/settings-section-loaders";
  import { Dialog } from "bits-ui";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import SettingsPageSkeleton from "./SettingsPageSkeleton.svelte";
  import { toastSurface } from "../ui/sonner/toast-surface.svelte";

  const session = getWorkspaceContext();
  const page = import("./SettingsPage.svelte");
  // Load the first section in parallel with the frame. The section shows its own load error.
  void settingsSectionLoaders[untrack(() => session.settingsTab)]().catch(() => {});
  let content = $state<HTMLDivElement | null>(null);
  useScope("settings-dialog", { exclusive: true, pre: true });

  function close() {
    session.router.close("settings");
  }
</script>

<Dialog.Root open onOpenChange={(open) => { if (!open) close(); }}>
  <Dialog.Portal>
    <!-- In the app's dialog band (10000), not z-50. The desktop workspace is not
         its own stacking context, so its layers (up to 9999) paint over anything
         lower. Dialogs that Settings opens sit at 10001; menus stay above at 10002. -->
    <Dialog.Overlay onclick={close} class="fixed inset-0 z-[10000] modal-backdrop" />
    <Dialog.Content
      bind:ref={content}
      {@attach (element) => toastSurface.attach(element)}
      aria-label="Settings"
      data-solus-ui
      data-settings-dialog
      onOpenAutoFocus={(event) => { event.preventDefault(); content?.focus(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); requestInputFocus(); }}
      class="no-drag pointer-events-none! fixed inset-0 z-[10000] outline-none"
    >
      <!-- The focus boundary fills the viewport. Toasts are inside it, but
           outside the transformed card, so their fixed offsets stay relative
           to the viewport. The frame lets scrim clicks reach the overlay. -->
      <div class="@container/pane pointer-events-auto fixed top-1/2 left-1/2 flex h-[min(76rem,88dvh)] w-[min(104rem,88%)] min-w-0 -translate-1/2 overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl dark:shadow-none [--solus-page-top-inset:0px]">
        <Dialog.Title class="sr-only">Settings</Dialog.Title>
        <Dialog.Description class="sr-only">Change Solus settings. Close to return to your workspace.</Dialog.Description>
        {#await page}
          <SettingsPageSkeleton />
        {:then loaded}
          <loaded.default />
        {:catch}
          <div class="flex flex-1 flex-col items-center justify-center gap-4 p-6">
            <p role="alert">Could not load settings. Close and try again.</p>
            <button type="button" class="rounded-lg border border-border px-3 py-2 text-workspace-chrome" onclick={close}>Close settings</button>
          </div>
        {/await}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
