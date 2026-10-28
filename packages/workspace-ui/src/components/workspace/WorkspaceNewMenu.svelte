<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    FileText as FileTextIcon,
    Network as ArchitectureIcon,
    Plus as PlusIcon,
    Upload as UploadSimpleIcon,
    Link2 as LinkIcon,
  } from "@lucide/svelte";
  import type { DocProviderId, DocProviderStatus } from "@solus/contracts/docs";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { docProviderLabel } from "../work/lib/work-publish";

  /** The page's one creating action: a document, a diagram, a Markdown file,
   *  or a page imported from a connected document provider. */
  interface Props {
    triggerClass: string;
    iconSize: number;
    onCreate: (type: "doc" | "diagram") => void;
    onImportFile: () => void;
    onImportFrom: (provider: DocProviderId) => void;
    /** A provider the user could sign in to is a route, not a dead end. */
    onOpenProviderSettings: () => void;
    loadDocProviders: () => Promise<DocProviderStatus[]>;
  }
  let { triggerClass, iconSize, onCreate, onImportFile, onImportFrom, onOpenProviderSettings, loadDocProviders }: Props = $props();

  let open = $state(false);
  let docProviders = $state<DocProviderStatus[]>([]);
  let docProvidersLoading = $state(false);

  // Which providers exist is a host fact the user can change in Settings while
  // this page stays mounted, so it is re-read each time the menu opens.
  $effect(() => {
    if (!open) return;
    docProvidersLoading = true;
    void loadDocProviders()
      .then((statuses) => (docProviders = statuses))
      .finally(() => (docProvidersLoading = false));
  });
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button {...props} type="button" class="text-workspace-chrome {triggerClass}" data-testid="workspace-new">
        <PlusIcon size={iconSize} weight="bold" class="shrink-0" />
        <span>New</span>
        <CaretDownIcon size={9} class="shrink-0 opacity-80" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <!-- Width is declared by the menu, not by the longest row: a
       fixed 160px wrapped "Import from URL…" onto two lines. -->
  <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8} class="w-auto min-w-56 max-w-[min(20rem,calc(100vw-2rem))] whitespace-nowrap">
    <DropdownMenu.Label>Create</DropdownMenu.Label>
    <DropdownMenu.Item class="text-workspace-chrome" onSelect={() => onCreate("doc")}>
      <FileTextIcon size={14} /><span class="flex-1 text-left">Document</span>
    </DropdownMenu.Item>
    <DropdownMenu.Item class="text-workspace-chrome" onSelect={() => onCreate("diagram")}>
      <ArchitectureIcon size={14} /><span class="flex-1 text-left">Diagram</span>
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item class="text-workspace-chrome" onSelect={onImportFile}>
      <UploadSimpleIcon size={14} /><span class="flex-1 text-left">Import .md…</span>
    </DropdownMenu.Item>
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger class="text-workspace-chrome" data-testid="workspace-import-doc">
        <LinkIcon size={14} /><span class="flex-1 text-left">Import from</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent class="w-auto min-w-52 max-w-[min(20rem,calc(100vw-2rem))] whitespace-nowrap">
        {#if docProvidersLoading}
          <DropdownMenu.Item disabled class="text-workspace-chrome">Checking connections…</DropdownMenu.Item>
        {:else if docProviders.length === 0}
          <DropdownMenu.Item disabled class="text-workspace-chrome">No document provider is available.</DropdownMenu.Item>
        {:else}
          <!-- Every provider is listed, connected or not: an absent row reads
               as "Solus cannot import from there" and sends the user looking
               in the wrong place. -->
          {#each docProviders as status (status.provider)}
            {#if status.connected}
              <DropdownMenu.Item class="text-workspace-chrome" data-testid={`import-from-${status.provider}`} onSelect={() => onImportFrom(status.provider)}>
                <LinkIcon size={14} /><span class="flex-1 text-left">{docProviderLabel(status.provider)}…</span>
              </DropdownMenu.Item>
            {:else if status.connectable}
              <DropdownMenu.Item class="h-auto py-1.5 text-workspace-chrome" data-testid={`connect-${status.provider}`} onSelect={() => { open = false; onOpenProviderSettings(); }}>
                <LinkIcon size={14} />
                <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                  <span>{docProviderLabel(status.provider)}</span>
                  <span class="max-w-full whitespace-normal text-(--solus-text-tertiary)">{status.reason} Connect in Settings…</span>
                </span>
              </DropdownMenu.Item>
            {:else}
              <DropdownMenu.Item class="h-auto py-1.5 text-workspace-chrome" data-testid={`unavailable-${status.provider}`} disabled>
                <LinkIcon size={14} />
                <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                  <span>{docProviderLabel(status.provider)}</span>
                  <span class="max-w-full whitespace-normal text-(--solus-text-tertiary)">{status.reason}</span>
                </span>
              </DropdownMenu.Item>
            {/if}
          {/each}
        {/if}
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  </DropdownMenu.Content>
</DropdownMenu.Root>
