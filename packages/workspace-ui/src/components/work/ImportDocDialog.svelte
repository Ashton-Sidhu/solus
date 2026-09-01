<script lang="ts">
  import { fade } from "svelte/transition";
  import { portal } from "../portal";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import type { DocProviderId } from "@solus/contracts/docs";
  import { importDocCopy } from "./lib/import-doc";

  /**
   * Import an upstream document by pasting its link. A URL is what a user
   * actually has — the alternative, browsing every space and folder, is a
   * second file tree to build and learn for the same outcome.
   */

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Named when the user picked a provider on the way in. The provider is
     *  still read from the URL itself; this only scopes what the dialog says. */
    provider?: DocProviderId;
  }

  let { open, onClose, provider }: Props = $props();

  const copy = $derived(importDocCopy(provider));

  const session = getWorkspaceContext();

  let url = $state("");
  let importing = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);

  // Typing is the next natural step, so the field takes focus as it appears.
  $effect(() => {
    if (open) inputEl?.focus();
  });

  async function submit() {
    const trimmed = url.trim();
    if (!trimmed || importing) return;
    importing = true;
    try {
      const work = await session.worksStore.importFromUrl(trimmed);
      toasts.success(`Imported “${work.title}”`);
      url = "";
      onClose();
      void session.openWorkModal(work.id, work.title, { via: "palette" });
    } catch (error) {
      toasts.error("Couldn't import that document", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      importing = false;
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:portal={document.body}
    data-solus-ui
    class="fixed inset-0 z-[200] flex items-center justify-center bg-black/12"
    role="presentation"
    onmousedown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
    transition:fade={{ duration: 120 }}
  >
    <div
      class="w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-border bg-popover p-5 text-foreground shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
    >
      <h2 class="text-sm font-medium">{copy.title}</h2>
      <p class="mt-1 text-xs text-muted-foreground">{copy.description}</p>
      <form
        class="mt-4 flex flex-col gap-3"
        onsubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          bind:ref={inputEl}
          bind:value={url}
          data-testid="import-doc-url"
          placeholder={copy.placeholder}
          autocomplete="off"
          spellcheck={false}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onclick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!url.trim() || importing}>
            {importing ? "Importing…" : "Import"}
          </Button>
        </div>
      </form>
    </div>
  </div>
{/if}
