<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { Input } from "../ui/input";
  import SettingsRow from "./SettingsRow.svelte";
  import { getSettingsContext } from "../../contexts";

  let { visible = true }: { visible?: boolean } = $props();
  const settings = getSettingsContext();

  function commitCompletedRetentionDays(value: number) {
    const days = Number.isFinite(value)
      ? Math.max(1, Math.min(365, Math.floor(value)))
      : settings.sidebarCompletedRetentionDays;
    settings.setPersonal("sidebarCompletedRetentionDays", days);
  }
</script>

<SettingsRow {...settingsDefinitions["sessions.completed-retention"]} {visible}>
  {#snippet control()}
    <div
      class="flex h-7 items-center overflow-hidden rounded-md border border-input bg-white shadow-xs/5 dark:bg-input/30"
    >
      <button
        type="button"
        onclick={() => commitCompletedRetentionDays(settings.sidebarCompletedRetentionDays - 1)}
        aria-label="Decrease days for completed sessions"
        class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >&minus;</button
      >
      <Input
        type="number"
        min={1}
        max={365}
        step={1}
        value={String(settings.sidebarCompletedRetentionDays)}
        aria-label="Days for completed sessions"
        onchange={(event) => {
          commitCompletedRetentionDays(Number((event.target as HTMLInputElement).value));
          (event.target as HTMLInputElement).value = String(settings.sidebarCompletedRetentionDays);
        }}
        class="h-auto w-9 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span class="mr-1 text-xs text-(--solus-text-tertiary)">d</span>
      <button
        type="button"
        onclick={() => commitCompletedRetentionDays(settings.sidebarCompletedRetentionDays + 1)}
        aria-label="Increase days for completed sessions"
        class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >+</button
      >
    </div>
  {/snippet}
</SettingsRow>
