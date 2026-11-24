<script lang="ts">
  /** The choice of one folder for a codebase: the host, then the folder with
   *  the directory picker, then what the host's scan found in it. The form
   *  that owns the `picker` adds the folder; this component only chooses. */
  import { FolderOpen as FolderOpenIcon } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { Button } from "../ui/button";
  import { ListChip } from "../ui/list-page";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import CodebaseMemberList from "./CodebaseMemberList.svelte";
  import { rootRefusalText } from "@solus/client-core/codebases";
  import { isContainerScan } from "@solus/contracts/codebases";
  import { countLabel, memberStateLabel, memberStateTint, scanSummary } from "./lib/codebase-view";
  import type { RootPickerState } from "./lib/root-picker.svelte";

  let { picker, disabled = false }: { picker: RootPickerState; disabled?: boolean } = $props();

  let isBrowsing = $state(false);
  let chooseButtonEl = $state<HTMLElement | null>(null);

  const host = $derived(picker.host);
  // Only a container gives its repositories to the codebase. A folder that is one project gives itself.
  const found = $derived(picker.scan && isContainerScan(picker.scan) ? picker.scan.members.filter((member) => member.discovered) : []);

  function closeBrowser() {
    isBrowsing = false;
    chooseButtonEl?.focus();
  }

  function choose(path: string) {
    closeBrowser();
    void picker.scanFolder(path);
  }
</script>

<div class="flex flex-col gap-3">
  {#if !host}
    <p class="text-sm text-muted-foreground">No host is connected. Connect a host, then choose a folder on it.</p>
  {:else}
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-workspace-chrome text-muted-foreground">On</span>
      {#if picker.hosts.length > 1}
        <SettingsSelect
          compact
          ariaLabel="Host of the folder"
          {disabled}
          options={picker.hosts.map((choice) => ({ value: choice.serverId, label: choice.label }))}
          value={host.serverId}
          onSelect={(serverId) => picker.chooseHost(serverId)}
        />
      {:else}
        <span class="text-workspace-chrome text-foreground">{host.label}</span>
      {/if}
      <Button bind:ref={chooseButtonEl} size="sm" variant="outline" {disabled} onclick={() => (isBrowsing = true)}>
        <FolderOpenIcon size={14} />
        {picker.scan ? "Choose a different folder" : "Choose folder"}
      </Button>
    </div>
  {/if}

  {#if picker.isScanning}
    <p class="text-sm text-muted-foreground" role="status">Reading the folder…</p>
  {:else if picker.error}
    <p class="text-sm text-destructive" role="alert">{picker.error}</p>
  {:else if picker.scan}
    {@const scan = picker.scan}
    <div class="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div class="flex min-w-0 items-center gap-2">
        <code class="min-w-0 font-mono text-xs break-all text-foreground">{scan.path}</code>
        <ListChip chip={{ label: memberStateLabel(scan.state), tint: memberStateTint(scan.state) }} />
      </div>
      {#if scan.state !== "missing"}
        <p class="text-[13px] leading-[1.45] text-(--solus-text-secondary)">{scanSummary(scan)}</p>
      {/if}
      {#if found.length > 0}
        <CodebaseMemberList members={found} label="Repositories found in the folder" />
      {/if}
      {#if scan.suggestions.length > 0}
        <p class="text-[13px] leading-[1.45] text-(--solus-text-secondary)">
          A workspace file in this folder lists {countLabel(scan.suggestions.length, "more folder", "more folders")}. You can add them after
          this one.
        </p>
      {/if}
      {#if picker.refusal}
        <p class="text-sm text-destructive" role="alert">{rootRefusalText(picker.refusal)}</p>
      {/if}
    </div>
  {/if}
</div>

{#if host}
  {#key host.serverId}
    <DirectoryPicker
      bind:open={isBrowsing}
      onClose={closeBrowser}
      onSelect={choose}
      title="Choose a folder for the codebase"
      actionLabel="Use this folder"
      api={serverConnections.apiFor(host.serverId)}
      serverId={host.serverId}
      hostLabel={host.label}
    />
  {/key}
{/if}
