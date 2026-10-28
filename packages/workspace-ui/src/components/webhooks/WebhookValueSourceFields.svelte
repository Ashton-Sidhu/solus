<script lang="ts">
  /** Where one value of a request comes from (docs/plans/webhooks.md §3.7): a
   *  header, one `key=value` part of a header, or the bearer token. */
  import { Input } from "../ui/input";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import type { ValueSourceDraft } from "./lib/webhook-draft";

  let { source = $bindable(), label, disabled = false }: { source: ValueSourceDraft; label: string; disabled?: boolean } = $props();

  const kindChoices: { value: ValueSourceDraft["kind"]; label: string }[] = [
    { value: "", label: "Choose" },
    { value: "header", label: "A header" },
    { value: "header_part", label: "A part of a header" },
    { value: "bearer", label: "The bearer token" },
  ];
  const separatorChoices: { value: ValueSourceDraft["separator"]; label: string }[] = [
    { value: "", label: "Choose" },
    { value: ",", label: "Comma" },
    { value: ";", label: "Semicolon" },
  ];
</script>

<div class="flex flex-wrap items-end gap-2">
  <div class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">{label}</span>
    <SettingsSelect compact ariaLabel="{label} source" options={kindChoices} value={source.kind} {disabled} onSelect={(kind) => (source.kind = kind)} />
  </div>
  {#if source.kind === "header" || source.kind === "header_part"}
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Header name</span>
      <Input bind:value={source.name} {disabled} class="h-7 w-48" aria-label="{label} header name" />
    </label>
  {/if}
  {#if source.kind === "header_part"}
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Part key</span>
      <Input bind:value={source.key} {disabled} class="h-7 w-24" aria-label="{label} part key" />
    </label>
    <div class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Separator</span>
      <SettingsSelect compact ariaLabel="{label} separator" options={separatorChoices} value={source.separator} {disabled} onSelect={(separator) => (source.separator = separator)} />
    </div>
  {/if}
</div>
