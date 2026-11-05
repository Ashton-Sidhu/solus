<script lang="ts">
  /** One `policy.json` document: its text, its check against the one validator,
   *  what the edit changes, Export in the three formats, and Import JSON with a
   *  confirmation that lists the changes. Read-only shows the text and Export. */
  import type { Snippet } from "svelte";
  import { Download as DownloadIcon, Upload as UploadIcon } from "@lucide/svelte";
  import type { PolicyDocument, PolicyKind } from "@solus/contracts/policy";
  import { POLICY_EXPORT_FORMATS, type PolicyExportFormat } from "@solus/client-core/policy-export";
  import { downloadText } from "../../insights/lib/trace-export";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { Textarea } from "../../ui/textarea";
  import { checkPolicyText, differenceLine } from "./lib/policy-editor";
  import { editDifferences, exportChoice, readImport, type PendingImport } from "./lib/policy-document-editor";

  interface Props {
    /** Names the text field for a screen reader. */
    label: string;
    kind: PolicyKind;
    text: string;
    /** The document that was read; the edit is compared with it. Null: it does not decode here. Absent: no comparison. */
    base?: PolicyDocument | null;
    readOnly?: boolean;
    onChange?: (text: string) => void;
    /** Save, Cancel, and other verbs of the owner of the document. */
    actions?: Snippet;
  }

  let { label, kind, text, base, readOnly = false, onChange, actions }: Props = $props();

  const check = $derived(checkPolicyText(text, kind));
  const changes = $derived(base === undefined ? [] : editDifferences(base, check));
  let pendingImport = $state<PendingImport | null>(null);
  let exportError = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  function exportAs(format: PolicyExportFormat) {
    const choice = exportChoice(check, format);
    if ("blocked" in choice) {
      exportError = choice.blocked;
      return;
    }
    exportError = null;
    downloadText(choice.file.fileName, choice.file.text, choice.file.mimeType);
  }

  async function importFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    pendingImport = readImport(file.name, await file.text(), check, kind);
  }

  function confirmImport() {
    if (pendingImport?.ok) onChange?.(pendingImport.text);
    pendingImport = null;
    requestInputFocus();
  }
</script>

<div class="flex flex-col gap-2">
  <Textarea
    aria-label={label}
    value={text}
    readonly={readOnly}
    spellcheck={false}
    oninput={(event) => onChange?.((event.currentTarget as HTMLTextAreaElement).value)}
    class="min-h-48 font-mono text-xs leading-relaxed"
  />

  <div class="flex flex-col gap-1 text-xs" aria-live="polite">
    {#if check.ok}
      <p class="text-muted-foreground" role="status">This document is valid.</p>
    {:else}
      <ul class="flex flex-col gap-0.5 text-destructive" role="alert">
        {#each check.issues as issue (issue)}
          <li class="font-mono">{issue}</li>
        {/each}
      </ul>
    {/if}
    {#if changes.length > 0}
      <details class="text-muted-foreground">
        <summary class="cursor-pointer select-none">{changes.length === 1 ? "1 change" : `${changes.length} changes`} from what was saved</summary>
        <ul class="mt-1 flex flex-col gap-0.5 font-mono">
          {#each changes as change (change.path)}
            <li>{differenceLine(change)}</li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if exportError}
      <p class="text-destructive" role="alert">{exportError}</p>
    {/if}
  </div>

  {#if pendingImport}
    <div class="flex flex-col gap-2 rounded-lg border border-border p-3 text-xs" role="alert" data-testid="policy-import-confirm">
      {#if pendingImport.ok}
        <p class="text-foreground">
          {pendingImport.differences.length === 0
            ? `${pendingImport.fileName} is the same as this document.`
            : `Import ${pendingImport.fileName}? It makes these changes:`}
        </p>
        {#if pendingImport.differences.length > 0}
          <ul class="flex max-h-48 flex-col gap-0.5 overflow-auto font-mono text-muted-foreground">
            {#each pendingImport.differences as change (change.path)}
              <li>{differenceLine(change)}</li>
            {/each}
          </ul>
        {/if}
        <div class="flex flex-wrap gap-2">
          <Button size="sm" disabled={pendingImport.differences.length === 0} onclick={confirmImport}>Import</Button>
          <Button size="sm" variant="ghost" onclick={() => (pendingImport = null)}>Cancel</Button>
        </div>
      {:else}
        <p class="text-destructive">{pendingImport.fileName} is not a valid policy:</p>
        <ul class="flex flex-col gap-0.5 font-mono text-destructive">
          {#each pendingImport.issues as issue (issue)}
            <li>{issue}</li>
          {/each}
        </ul>
        <div><Button size="sm" variant="ghost" onclick={() => (pendingImport = null)}>Close</Button></div>
      {/if}
    </div>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex flex-wrap gap-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" disabled={!check.ok}>
              <DownloadIcon size={16} />
              Export
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="start" sideOffset={6}>
          {#each POLICY_EXPORT_FORMATS as format (format.format)}
            <DropdownMenu.Item onSelect={() => exportAs(format.format)}>
              <div class="flex flex-col">
                <span>{format.label}</span>
                <span class="text-xs text-muted-foreground">{format.description}</span>
              </div>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {#if !readOnly}
        <Button variant="outline" size="sm" onclick={() => fileInput?.click()}>
          <UploadIcon size={16} />
          Import JSON
        </Button>
        <input bind:this={fileInput} type="file" accept="application/json,.json" class="hidden" onchange={(event) => void importFile(event.currentTarget)} />
      {/if}
    </div>
    {#if actions}
      <div class="flex flex-wrap gap-2">{@render actions()}</div>
    {/if}
  </div>
</div>
