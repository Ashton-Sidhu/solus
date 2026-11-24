<script lang="ts">
  import { Button } from "../ui/button";
  import type { FilePreviewPage, FilePreviewResult } from "@solus/contracts/types";
  import { toasts } from "../../lib/toasts";

  let { initial, contents, read, reload }: {
    initial: FilePreviewPage;
    contents: string;
    read: (index: number, revision: string) => Promise<FilePreviewResult>;
    reload: () => void;
  } = $props();

  let current = $state<{ index: number; contents: string } | null>(null);
  let pending = $state(false);
  let error = $state("");
  const index = $derived(current?.index ?? initial.index);
  const text = $derived(current?.contents ?? contents);

  async function move(nextIndex: number) {
    pending = true;
    error = "";
    try {
      const result = await read(nextIndex, initial.revision);
      if (!result.ok) throw new Error(result.error);
      if (result.kind !== "text" || result.page?.index !== nextIndex) {
        throw new Error("The host could not send this page.");
      }
      current = { index: nextIndex, contents: result.contents };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The host could not send this page.";
    } finally {
      pending = false;
    }
  }

  async function copyPage() {
    try {
      await navigator.clipboard.writeText(text);
      toasts.success("Page copied");
    } catch {
      toasts.error("Could not copy page");
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
    <Button variant="ghost" size="sm" disabled={pending || index === 0} onclick={() => move(0)}>First</Button>
    <Button variant="ghost" size="sm" disabled={pending || index === 0} onclick={() => move(index - 1)}>Previous</Button>
    <span class="px-1 text-xs tabular-nums" aria-live="polite">
      {pending ? "Loading page…" : `Page ${index + 1} of ${initial.count}`}
    </span>
    <Button variant="ghost" size="sm" disabled={pending || index >= initial.count - 1} onclick={() => move(index + 1)}>Next</Button>
    <Button variant="ghost" size="sm" disabled={pending || index >= initial.count - 1} onclick={() => move(initial.count - 1)}>Last</Button>
    <Button variant="ghost" size="sm" onclick={copyPage}>Copy page</Button>
  </div>
  {#if error}
    <div class="flex items-center gap-1 px-3 text-xs" role="alert">
      {error}
      <Button variant="ghost" size="sm" onclick={reload}>Reload file</Button>
    </div>
  {/if}
  {#key index}
    <div class="min-h-0 flex-1 overflow-auto" tabindex="0" role="region" aria-label="File contents">
      <pre class="whitespace-pre-wrap break-all p-3 font-mono text-xs">{text}</pre>
    </div>
  {/key}
</div>
