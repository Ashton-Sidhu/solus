<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  /** Which ignored files go with this project's work to another host, and
   *  into new worktrees: its `.worktreeinclude` (docs/run-on.md#copied-files). */
  import { Button } from "../ui/button";
  import CopiedFilesDialog from "../servers/CopiedFilesDialog.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  interface Props {
    serverId: string;
    cwd: string;
  }

  let { serverId, cwd }: Props = $props();

  let open = $state(false);
  let configureButton = $state<HTMLElement | null>(null);
</script>

<SettingsRow
  {...settingsDefinitions["source-control.files-copied-to-other-hosts"]}
>
  {#snippet control()}
    <Button bind:ref={configureButton} variant="outline" size="sm" onclick={() => (open = true)}>Configure…</Button>
  {/snippet}
</SettingsRow>

<CopiedFilesDialog bind:open {serverId} {cwd} onClose={() => configureButton?.focus()} />
