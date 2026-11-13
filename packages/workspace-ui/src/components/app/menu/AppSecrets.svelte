<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import type { AppSecretState, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import AppSectionState from "./AppSectionState.svelte";

  /**
   * The secrets the active version declares. The owner gives each one a value
   * or clears it. A value is never read back: a row says only whether it is set.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    secrets: AppSecretState[] | undefined;
  }
  let { serverId, app, secrets }: Props = $props();

  /** What the person typed in this edit only, by secret name. */
  const drafts = new SvelteMap<string, string>();
  let busyName = $state<string | null>(null);

  async function save(name: string, value: string | null) {
    if (busyName || value === "") return;
    busyName = name;
    try {
      await appsStore.setSecret(serverId, app.id, name, value);
      drafts.delete(name);
    } catch (error) {
      toasts.error(value === null ? "The secret was not cleared" : "The secret was not saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busyName = null;
    }
  }
</script>

<AppSectionState
  count={secrets?.length}
  error={appsStore.stateErrorFor(serverId, app.id)}
  empty="This app declares no secret."
  onRetry={() => void appsStore.loadState(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="app-secrets">
    {#each secrets ?? [] as secret (secret.name)}
      <li class="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/50 px-3 py-2">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="min-w-0 truncate font-medium">{secret.label}</span>
          <span class="shrink-0 text-xs {secret.isSet ? 'text-muted-foreground' : 'text-(--warning)'}">{secret.isSet ? "Set" : "Not set"}</span>
        </div>
        {#if secret.description}
          <p class="m-0 text-xs text-muted-foreground text-pretty">{secret.description}</p>
        {/if}
        <div class="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            autocomplete="off"
            class="h-7 w-72 max-w-full"
            aria-label="New value of {secret.label}"
            placeholder={secret.isSet ? "New value" : "Value"}
            disabled={busyName !== null}
            value={drafts.get(secret.name) ?? ""}
            oninput={(event) => drafts.set(secret.name, event.currentTarget.value)}
            onSubmit={() => void save(secret.name, drafts.get(secret.name) ?? "")}
          />
          <Button size="xs" disabled={busyName !== null || !drafts.get(secret.name)} onclick={() => void save(secret.name, drafts.get(secret.name) ?? "")}>
            Save
          </Button>
          {#if secret.isSet}
            <Button size="xs" variant="outline" disabled={busyName !== null} onclick={() => void save(secret.name, null)}>Clear</Button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</AppSectionState>
