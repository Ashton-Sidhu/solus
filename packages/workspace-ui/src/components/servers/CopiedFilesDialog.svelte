<script lang="ts">
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  /**
   * Which files git ignores still go with the work (docs/run-on.md#copied-files).
   * The boxes edit the project's `.worktreeinclude`: Run on copies those files
   * into a clone on another host, and a new worktree gets them too.
   */
  import { Dialog } from "bits-ui";
  import { X } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { Button } from "../ui/button";
  import { Checkbox } from "../ui/checkbox";
  import { formatFileSize } from "../files/lib/non-text-file";
  import { CopiedFilesDraft } from "./lib/copied-files.svelte";
  import { isCopyable } from "./lib/copied-files";

  interface Props {
    open: boolean;
    /** The host that holds the project's checkout. */
    serverId: string;
    /** The project's checkout on that host. */
    cwd: string;
    /** The dialog closed, saved or not. */
    onClose: () => void;
  }

  let { open = $bindable(), serverId, cwd, onClose }: Props = $props();

  // One draft for each opening, so Cancel leaves nothing behind.
  let draft = $state<CopiedFilesDraft | null>(null);
  $effect(() => {
    if (!open) return;
    const next = new CopiedFilesDraft(serverConnections.apiFor(serverId), cwd);
    draft = next;
    void next.load();
  });

  async function save() {
    if (draft && (await draft.save())) open = false;
  }

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => open });
</script>

<Dialog.Root bind:open onOpenChangeComplete={(isOpen) => { if (!isOpen) onClose(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 modal-backdrop duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <Dialog.Content
      class="text-workspace-chrome fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] flex-col gap-4 overflow-y-auto rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) p-6 shadow-(--solus-popover-shadow) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
      data-testid="copied-files-dialog"
    >
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" class="absolute top-4 right-4 text-muted-foreground pointer-coarse:size-11" aria-label="Close"><X size={16} /></Button>
        {/snippet}
      </Dialog.Close>

      <div class="flex flex-col gap-1 pr-8">
        <Dialog.Title class="font-medium text-foreground">Files copied to other hosts</Dialog.Title>
        <Dialog.Description class="text-(--solus-text-secondary)">
          Run on copies these files into a clone that does not have them. They are saved in <code class="font-mono text-[0.9em]">.worktreeinclude</code>, so new worktrees get them too.
        </Dialog.Description>
      </div>

      {#if draft}
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2">
            <span class="flex-1 font-medium text-foreground">Ignored files</span>
            {#if draft.copyable.length > 0}
              <span class="text-xs text-(--solus-text-tertiary) tabular-nums">
                {draft.chosen.size} of {draft.files.length}{draft.chosenBytes > 0 ? ` · ${formatFileSize(draft.chosenBytes)}` : ""}
              </span>
              <Button variant="ghost" size="xs" disabled={draft.status !== "ready"} onclick={() => draft?.toggleAll()}>
                {draft.allChosen ? "None" : "All"}
              </Button>
            {/if}
          </div>

          {#if draft.status === "loading"}
            <p class="text-xs text-(--solus-text-tertiary)">Finding ignored files…</p>
          {:else if draft.status === "failed"}
            <p class="text-xs text-destructive" role="alert">{draft.error}</p>
            <Button variant="outline" size="sm" class="self-start" onclick={() => draft?.load()}>Try again</Button>
          {:else if draft.files.length === 0}
            <p class="text-xs text-(--solus-text-tertiary)">Git ignores no files in this project.</p>
          {:else}
            <div class="max-h-60 overflow-y-auto rounded-lg border border-(--solus-tool-border)">
              {#each draft.files as file (file.path)}
                {@const fits = isCopyable(file)}
                <label class="flex min-w-0 cursor-pointer items-center gap-2.5 px-3 py-1.5 not-last:border-b not-last:border-(--solus-tool-border) has-disabled:cursor-not-allowed has-disabled:opacity-60 pointer-coarse:py-2.5">
                  <Checkbox
                    checked={draft.chosen.has(file.path)}
                    disabled={!fits || draft.status === "saving"}
                    onCheckedChange={(checked) => draft?.toggle(file.path, checked === true)}
                  />
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{file.path}</span>
                  <span class="shrink-0 text-xs text-(--solus-text-tertiary) tabular-nums">{fits ? formatFileSize(file.byteLength) : "Over 1 MB"}</span>
                </label>
              {/each}
            </div>
            {#if draft.truncated}
              <p class="text-xs text-(--solus-text-tertiary)">Showing the first {draft.files.length} files.</p>
            {/if}
          {/if}

          <p class="text-xs text-(--solus-text-tertiary)">
            {#if draft.status === "ready" && !draft.hasIncludeFile}
              This project has no .worktreeinclude yet. Its env files are selected; Save makes the file.
            {:else}
              A file the clone already has is not replaced. Folders git ignores whole, like node_modules, are not listed.
            {/if}
          </p>
          {#if draft.error && draft.status !== "failed"}
            <p class="text-xs text-destructive" role="alert">{draft.error}</p>
          {/if}
        </div>
      {/if}

      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button
          disabled={!draft || draft.status !== "ready" || (draft.changes.length === 0 && draft.hasIncludeFile)}
          onclick={save}
        >
          {draft?.status === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
