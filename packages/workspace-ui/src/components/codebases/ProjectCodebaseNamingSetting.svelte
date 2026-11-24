<script lang="ts">
  /** A project's override of how Solus names a codebase that it forms from
   *  this project and a second one. It is saved in the project's
   *  `.solus/config.json`, so a team can commit it, as the branch naming of
   *  the project is. */
  import { untrack } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import type { CodebaseNaming } from "@solus/contracts/codebases";
  import { getProjectConfigStore } from "../../contexts";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import { CODEBASE_NAMING_OPTIONS } from "./lib/codebase-view";

  let { serverId, api, cwd }: { serverId: string; api: HostApi; cwd: string } = $props();

  /** No override: the project uses the setting of the person. */
  const PERSONAL = "personal";
  const options: ReadonlyArray<{ value: CodebaseNaming | typeof PERSONAL; label: string }> = [
    { value: PERSONAL, label: "Your setting" },
    ...CODEBASE_NAMING_OPTIONS.map(({ value, label }) => ({ value, label })),
  ];

  const projectConfig = getProjectConfigStore();
  const config = $derived(projectConfig.configFor(serverId, cwd));
  let saving = $state(false);
  let error = $state("");

  $effect(() => {
    const host = { serverId, api };
    const projectCwd = cwd;
    untrack(() => {
      error = "";
      void projectConfig.load(host, projectCwd).catch(() => {
        error = "Could not load this project's settings.";
      });
    });
  });

  async function save(naming: CodebaseNaming | typeof PERSONAL): Promise<void> {
    saving = true;
    error = "";
    try {
      await projectConfig.save({ serverId, api }, cwd, { codebaseNaming: naming === PERSONAL ? undefined : naming });
    } catch {
      error = "Could not save the codebase naming of this project. Try again.";
      await projectConfig.load({ serverId, api }, cwd).catch(() => {});
    } finally {
      saving = false;
    }
  }
</script>

<SettingsRow {...settingsDefinitions["source-control.override-codebase-names"]}>
  {#snippet control()}
    <SettingsSelect
      {options}
      value={config?.codebaseNaming ?? PERSONAL}
      onSelect={(naming) => void save(naming)}
      ariaLabel="Codebase names for this project"
      disabled={config === undefined || saving}
    />
  {/snippet}
</SettingsRow>
{#if error}
  <p class="px-4 pb-3.5 text-xs text-destructive" role="alert">{error}</p>
{/if}
