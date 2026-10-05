<script lang="ts">
  /** A project's override of your worktree branch naming. It is saved
   *  in the project's `.solus/config.json`, so a team can commit it. */
  import { untrack } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import type { WorktreeBranchNaming } from "@solus/contracts/worktree-branch-naming";
  import { getProjectConfigStore, getSettingsContext } from "../../contexts";
  import { Switch } from "../ui/switch";
  import SettingsRow from "./SettingsRow.svelte";
  import WorktreeBranchNamingRow from "./WorktreeBranchNamingRow.svelte";

  interface Props {
    serverId: string;
    api: HostApi;
    cwd: string;
  }

  let { serverId, api, cwd }: Props = $props();

  const projectConfig = getProjectConfigStore();
  const config = $derived(projectConfig.configFor(serverId, cwd));
  const override = $derived(config?.worktreeBranchNaming ?? null);
  const settings = getSettingsContext();
  // The person's own naming: what a project without an override uses.
  const personalNaming = $derived(settings.worktreeBranchNaming);
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

  async function save(naming: WorktreeBranchNaming | undefined): Promise<void> {
    saving = true;
    error = "";
    try {
      await projectConfig.save({ serverId, api }, cwd, { worktreeBranchNaming: naming });
    } catch {
      error = "Could not save this project's branch naming. Try again.";
      await projectConfig.load({ serverId, api }, cwd).catch(() => {});
    } finally {
      saving = false;
    }
  }
</script>

<SettingsRow
  label="Override branch names"
  description="Use a different naming for this project. Saved in .solus/config.json, so you can commit it."
>
  {#snippet control()}
    <Switch
      checked={override !== null}
      disabled={config === undefined || saving}
      onCheckedChange={(enabled) => void save(enabled ? { ...personalNaming } : undefined)}
      aria-label="Override branch names for this project"
    />
  {/snippet}
</SettingsRow>
{#if override}
  <WorktreeBranchNamingRow
    label="Project branch names"
    naming={override}
    disabled={saving}
    onSave={(naming) => void save(naming)}
  />
{/if}
{#if error}
  <p class="px-4 pb-3.5 text-xs text-destructive" role="alert">{error}</p>
{/if}
