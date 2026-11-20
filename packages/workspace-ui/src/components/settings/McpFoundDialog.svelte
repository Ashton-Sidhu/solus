<script lang="ts">
  /**
   * The approval of a found server (docs/plans/mcp-first-class.md §8.3, §8.6):
   * the command or URL exactly as the host read it, the files, and for a
   * `changed` server the one in use beside the one in the file. The host reads
   * the file again at the add and refuses another entry, so the person approves
   * what they read here. The shell follows `McpConnectDialog`, with no outline
   * border: the shadow and the backdrop set it apart from the page.
   */
  import { Dialog } from "bits-ui";
  import { TriangleAlert, X } from "@lucide/svelte";
  import type { FoundServer, Integration } from "@solus/contracts/integration-types";
  import { commandLineText, fileValuesText, foundPlacesText, foundTargetText, projectCommandWarning } from "@solus/contracts/integrations/found-server-labels";
  import { Button } from "../ui/button";
  import { Checkbox } from "../ui/checkbox";
  import McpServerIcon from "./McpServerIcon.svelte";

  interface Props {
    server: FoundServer;
    /** The integration a `changed` server would update. */
    current: Integration | null;
    projectName: string | null;
    isAdding: boolean;
    error: string;
    onConfirm: (useFileValues: boolean) => void;
    onClose: () => void;
  }
  let { server, current, projectName, isAdding, error, onConfirm, onClose }: Props = $props();

  let open = $state(true);
  let useFileValues = $state(true);
  const isChange = $derived(server.state === "changed");
  const valuesText = $derived(fileValuesText(server));
  const url = $derived(server.transport && server.transport.kind !== "stdio" ? server.transport.url : "");
  const currentText = $derived(current?.launch ? commandLineText({ kind: "stdio", command: current.launch.command, args: current.launch.args, envNames: [] }) : current?.url ?? "");
  const checkboxId = $props.id();
</script>

{#snippet targetBlock(label: string, text: string)}
  <div class="flex flex-col gap-1">
    <p class="text-chrome-dense text-(--solus-text-secondary)">{label}</p>
    <code class="rounded-lg bg-muted px-3 py-2 font-mono text-chrome-dense break-all text-foreground">{text}</code>
  </div>
{/snippet}

<Dialog.Root bind:open onOpenChangeComplete={(isOpen) => { if (!isOpen) onClose(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[10001] modal-backdrop duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <Dialog.Content
      class="text-workspace-chrome fixed inset-0 z-[10001] m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] flex-col gap-4 overflow-y-auto rounded-2xl bg-(--solus-container-bg) p-6 shadow-(--solus-popover-shadow) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
      data-testid="mcp-found-dialog"
    >
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" class="absolute top-4 right-4 text-muted-foreground pointer-coarse:tap-area" aria-label="Close"><X size={16} /></Button>
        {/snippet}
      </Dialog.Close>

      <div class="flex items-center gap-3 pr-8">
        <McpServerIcon name={server.name} {url} />
        <div class="flex min-w-0 flex-col">
          <Dialog.Title class="truncate font-medium text-foreground">{isChange ? `Review the change to ${server.name}` : `Add ${server.name}`}</Dialog.Title>
          <Dialog.Description class="text-chrome-dense text-(--solus-text-secondary)">{foundPlacesText(server)}</Dialog.Description>
        </div>
      </div>

      {#if isChange && currentText}
        {@render targetBlock("In use now", currentText)}
        {@render targetBlock("In the file", foundTargetText(server))}
      {:else}
        {@render targetBlock(server.transport?.kind === "stdio" ? "Command" : "Address", foundTargetText(server))}
      {/if}

      {#if server.transport?.kind === "stdio"}
        <p class="text-pretty text-(--solus-text-secondary)">
          {isChange ? "The new command does not start until you start it." : "It runs on this host as the Solus server's user. It does not start until you start it."}
        </p>
      {/if}
      {#if server.projectOnly && server.transport?.kind === "stdio" && projectName}
        <p class="flex items-start gap-1.5 text-(--solus-status-permission)">
          <TriangleAlert size={16} class="mt-0.5 shrink-0" aria-hidden="true" />{projectCommandWarning(projectName)}
        </p>
      {/if}
      {#if server.projectOnly && projectName}
        <p class="text-(--solus-text-secondary)">It reaches only the agents that work in {projectName}.</p>
      {/if}

      {#if valuesText}
        <label for={checkboxId} class="flex items-center gap-2.5 text-foreground pointer-coarse:min-h-11">
          <Checkbox id={checkboxId} bind:checked={useFileValues} />{valuesText}
        </label>
      {/if}

      {#if error}<p role="alert" class="break-words text-(--solus-status-error)">{error}</p>{/if}

      <div class="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => { open = false; }}>Cancel</Button>
        <Button size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isAdding} onclick={() => onConfirm(useFileValues && valuesText !== null)}>
          {isAdding ? (isChange ? "Updating…" : "Adding…") : isChange ? "Update" : "Add"}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
