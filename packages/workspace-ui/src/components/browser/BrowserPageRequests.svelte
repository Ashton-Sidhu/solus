<script lang="ts">
  import { FileUp, MessageSquare } from "@lucide/svelte";
  import type { BrowserPage } from "@solus/contracts/browser-types";
  import { browserDialogChoices } from "@solus/client-core/browser-page-requests";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";

  /**
   * What a streamed page asks of the person watching it: a JavaScript dialog,
   * or files for its file chooser.
   *
   * A page the host renders headless has no system dialog or picker that
   * anyone could see, so the question is page state and every client that
   * streams the page asks it here. The first answer from any client wins.
   */

  interface Props {
    pageKey: string;
    page: BrowserPage;
  }

  let { pageKey, page }: Props = $props();

  const dialog = $derived(page.dialog ?? null);
  const choices = $derived(dialog ? browserDialogChoices(dialog) : null);
  const fileChooser = $derived(page.fileChooser ?? null);
  /** The prompt's text, kept per dialog so a new one starts from its own default. */
  let promptDrafts = $state<Record<number, string>>({});
  let busy = $state(false);
  let picker = $state<HTMLInputElement | null>(null);

  async function run(label: string, work: () => Promise<void>) {
    busy = true;
    try {
      await work();
    } catch (error) {
      toasts.error(label, { description: error instanceof Error ? error.message : undefined });
    } finally {
      busy = false;
    }
  }

  function answer(accept: boolean) {
    if (!dialog) return;
    const promptText = dialog.type === "prompt" && accept ? (promptDrafts[dialog.sequence] ?? dialog.defaultPrompt ?? "") : undefined;
    void run("Couldn't answer the page", () =>
      browserStore.answerDialog(pageKey, promptText === undefined ? { accept } : { accept, promptText }),
    );
  }

  function chooseFiles(event: Event) {
    if (!(event.currentTarget instanceof HTMLInputElement)) return;
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (files.length === 0) return;
    void run("Couldn't give the page the files", () => browserStore.answerFileChooser(pageKey, files));
  }
</script>

{#if dialog && choices}
  <div class="absolute inset-x-0 top-3 z-20 flex justify-center px-3">
    <form
      class="text-workspace-chrome flex w-[min(24rem,100%)] flex-col gap-2.5 rounded-[14px] bg-[var(--popover)] p-3.5 shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0.5rem_1rem_-0.5rem_rgba(0,0,0,0.18),0_2rem_3rem_-1.5rem_rgba(0,0,0,0.34)]"
      role="alertdialog"
      aria-labelledby="browser-page-dialog-title"
      onsubmit={(event) => {
        event.preventDefault();
        answer(true);
      }}
      onkeydown={(event) => {
        if (event.key !== "Escape" || !choices.dismiss) return;
        event.stopPropagation();
        answer(false);
      }}
    >
      <div class="flex items-center gap-2">
        <MessageSquare class="size-3.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
        <span id="browser-page-dialog-title" class="min-w-0 truncate font-medium text-(--solus-text-primary)">{choices.title}</span>
      </div>
      {#if choices.message}
        <p class="max-h-40 overflow-y-auto break-words whitespace-pre-wrap text-(--solus-text-secondary)">{choices.message}</p>
      {/if}
      {#if dialog.type === "prompt"}
        <!-- svelte-ignore a11y_autofocus -->
        <Input
          autofocus
          aria-label="Answer"
          value={promptDrafts[dialog.sequence] ?? dialog.defaultPrompt ?? ""}
          oninput={(event) => (promptDrafts[dialog.sequence] = event.currentTarget.value)}
        />
      {/if}
      <div class="flex items-center justify-end gap-1.5 pt-0.5">
        {#if choices.dismiss}
          <Button type="button" variant="ghost" size="sm" disabled={busy} onclick={() => answer(false)}>{choices.dismiss}</Button>
        {/if}
        <!-- svelte-ignore a11y_autofocus -->
        <Button type="submit" size="sm" disabled={busy} autofocus={dialog.type !== "prompt"}>{choices.accept}</Button>
      </div>
    </form>
  </div>
{:else if fileChooser}
  <div class="absolute inset-x-0 top-3 z-20 flex justify-center px-3">
    <div
      class="text-workspace-chrome flex w-[min(24rem,100%)] flex-col gap-2.5 rounded-[14px] bg-[var(--popover)] p-3.5 shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0.5rem_1rem_-0.5rem_rgba(0,0,0,0.18),0_2rem_3rem_-1.5rem_rgba(0,0,0,0.34)]"
      role="dialog"
      aria-labelledby="browser-file-chooser-title"
    >
      <div class="flex items-center gap-2">
        <FileUp class="size-3.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
        <span id="browser-file-chooser-title" class="min-w-0 truncate font-medium text-(--solus-text-primary)">
          The page asks for {fileChooser.multiple ? "files" : "a file"}
        </span>
      </div>
      <p class="text-(--solus-text-secondary)">They go to the host that runs this page, then to the page.</p>
      <input bind:this={picker} class="hidden" type="file" multiple={fileChooser.multiple} onchange={chooseFiles} />
      <div class="flex items-center justify-end gap-1.5 pt-0.5">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => void run("Couldn't cancel the file chooser", () => browserStore.answerFileChooser(pageKey, null))}
        >
          Cancel
        </Button>
        <!-- svelte-ignore a11y_autofocus -->
        <Button size="sm" disabled={busy} autofocus onclick={() => picker?.click()}>
          {busy ? "Uploading…" : fileChooser.multiple ? "Choose files" : "Choose file"}
        </Button>
      </div>
    </div>
  </div>
{/if}
