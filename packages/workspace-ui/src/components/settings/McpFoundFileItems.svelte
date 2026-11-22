<script lang="ts">
  /**
   * The menu items of a found server's config files (docs/plans/mcp-first-class.md
   * §8.8): turn it off or on for the tool that keeps a file, open a file in the
   * configured editor, and delete the entry from a file. Shared by the row of
   * "On this host" and the Installed row, so both say the same thing. A delete
   * goes to the parent, which asks first.
   */
  import { FileCode, Power, PowerOff, Trash2 } from "@lucide/svelte";
  import type { FoundPlace, FoundServer } from "@solus/contracts/integration-types";
  import { foundFileActions, type FoundFileAction } from "@solus/contracts/integrations/found-server-labels";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { MiddleTruncate } from "../ui/middle-truncate";

  interface Props {
    server: FoundServer;
    /** The Installed row leaves turning off to Solus: its runs already leave the tool's copy out (§8.5). */
    showTurnOff: boolean;
    /** This client can open a file of the host in the configured editor. */
    canOpenFiles: boolean;
    onOpen: (place: FoundPlace) => void;
    onAction: (action: FoundFileAction) => void;
  }
  let { server, showTurnOff, canOpenFiles, onOpen, onAction }: Props = $props();

  const actions = $derived(foundFileActions(server));
  const turns = $derived(showTurnOff ? actions.filter((action) => action.change !== "delete") : []);
  const deletes = $derived(actions.filter((action) => action.change === "delete"));
  const files = $derived(canOpenFiles ? server.foundIn.filter((place): place is FoundPlace => place.kind === "file") : []);
</script>

{#if turns.length || files.length}<DropdownMenu.Separator />{/if}
{#each turns as action (`${action.place.path}:${action.change}`)}
  <DropdownMenu.Item onSelect={() => onAction(action)}>
    {#if action.change === "turn-on"}<Power size={14} />{:else}<PowerOff size={14} />{/if}{action.label}
  </DropdownMenu.Item>
{/each}
{#each files as place (place.path)}
  <!-- The path trails the verb, muted, so a list of files scans by what the item does. -->
  <DropdownMenu.Item onSelect={() => onOpen(place)}>
    <FileCode size={14} /><span class="shrink-0">Open</span>
    <MiddleTruncate value={place.path} class="ml-auto font-mono text-xs text-muted-foreground" />
  </DropdownMenu.Item>
{/each}
{#if deletes.length}<DropdownMenu.Separator />{/if}
{#each deletes as action (action.place.path)}
  <DropdownMenu.Item variant="destructive" onSelect={() => onAction(action)}><Trash2 size={14} />{action.label}…</DropdownMenu.Item>
{/each}
