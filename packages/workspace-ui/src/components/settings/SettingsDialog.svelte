<script lang="ts">
  import { untrack } from "svelte";
  import { settingsSection } from "./lib/settings-section-loaders";
  import { Dialog } from "bits-ui";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import SettingsPageSkeleton from "./SettingsPageSkeleton.svelte";
  import { toastSurface } from "../ui/sonner/toast-surface.svelte";
  import { ModalResizeHandles, ResizableModal } from "../ui/modal-resize";

  const session = getWorkspaceContext();
  // Load the first section beside the frame, and keep the page skeleton until both are ready.
  // The section is then cached and renders at once, with no section skeleton between.
  // The section shows its own load error.
  const firstSection = Promise.resolve(settingsSection(untrack(() => session.settingsTab))).catch(() => {});
  const page = Promise.all([import("./SettingsPage.svelte"), firstSection]).then(([loaded]) => loaded);
  let content = $state<HTMLDivElement | null>(null);
  let open = $state(true);
  const resizable = new ResizableModal("settings");
  useScope("settings-dialog", { exclusive: true, pre: true });

  function close() {
    open = false;
  }
</script>

<!-- The route closes only after the exit animation, so the close is seen. -->
<Dialog.Root bind:open onOpenChangeComplete={(isOpen) => { if (!isOpen) session.router.close("settings"); }}>
  <Dialog.Portal>
    <!-- In the app's dialog band (10000), not z-50. The desktop workspace is not
         its own stacking context, so its layers (up to 9999) paint over anything
         lower. Dialogs that Settings opens sit at 10001; menus stay above at 10002. -->
    <Dialog.Overlay onclick={close} class="fixed inset-0 z-[10000] modal-backdrop duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <Dialog.Content
      bind:ref={content}
      {@attach (element) => toastSurface.attach(element)}
      aria-label="Settings"
      data-solus-ui
      data-settings-dialog
      onOpenAutoFocus={(event) => { event.preventDefault(); content?.focus(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); requestInputFocus(); }}
      class="no-drag pointer-events-none! fixed inset-0 z-[10000] outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
    >
      <!-- The focus boundary fills the viewport. Toasts are inside it, but
           outside the transformed card, so their fixed offsets stay relative
           to the viewport. The frame lets scrim clicks reach the overlay.
           The zoom is on this full-viewport layer, so it scales from the
           card's centre and keeps no transform after it ends. -->

      <!-- 93rem: the navigation column, the page padding, and a 72rem reading
           column. The content fills the card, so a resize changes it. -->
      <div class="@container/pane pointer-events-auto fixed top-1/2 left-1/2 flex h-[min(76rem,88dvh)] w-[min(93rem,88%)] min-w-0 -translate-1/2 overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl dark:shadow-none [--solus-page-top-inset:0px]" style={resizable.style}>
        <Dialog.Title class="sr-only">Settings</Dialog.Title>
        <Dialog.Description class="sr-only">Change Solus settings. Close to return to your workspace.</Dialog.Description>
        {#await page}
          <SettingsPageSkeleton />
        {:then loaded}
          <loaded.default onClose={close} />
        {:catch}
          <div class="flex flex-1 flex-col items-center justify-center gap-4 p-6">
            <p role="alert">Could not load settings. Close and try again.</p>
            <button type="button" class="rounded-lg border border-border px-3 py-2 text-workspace-chrome" onclick={close}>Close settings</button>
          </div>
        {/await}
        <ModalResizeHandles modal={resizable} label="Resize settings" />
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
