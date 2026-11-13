<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { serverConnections } from "@solus/client-core/server-connections";
  import type { AppConfigState, AppConfigValue, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import { Switch } from "../../ui/switch";
  import { Textarea } from "../../ui/textarea";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";
  import ManageHeading from "./ManageHeading.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { configDefaultText, configRangeHint, modelSettingOptions, parseConfigDraft } from "@solus/client-core/app-config";
  import { getTextGenerationSettingsStore } from "../../../contexts";

  /**
   * The config the active version declares (docs/plans/apps.md §4.4). The
   * owner changes a value here; the app's backend and its UI read it. A switch
   * and a choice save at once; text and a number save with Save or Enter.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    config: AppConfigState[] | undefined;
  }
  let { serverId, app, config }: Props = $props();

  // A model setting offers the models this host can run (docs/plans/app-models.md §4).
  const textGenerationSettings = getTextGenerationSettingsStore();
  const declaresModel = $derived(config?.some((field) => field.type === "model") ?? false);
  $effect(() => {
    const hostId = serverId;
    if (!declaresModel) return;
    untrack(() => void textGenerationSettings.load({ serverId: hostId, api: serverConnections.apiFor(hostId) }).catch(() => {}));
  });
  const hostModels = $derived(textGenerationSettings.snapshotFor(serverId)?.agents ?? []);

  /** What the person typed in this edit only, by field name. */
  const drafts = new SvelteMap<string, string>();
  let busyName = $state<string | null>(null);

  async function save(field: AppConfigState, value: AppConfigValue | null) {
    if (busyName) return;
    busyName = field.name;
    try {
      await appsStore.setConfig(serverId, app.id, field.name, value);
      drafts.delete(field.name);
    } catch (error) {
      toasts.error(value === null ? `${field.label} was not reset` : `${field.label} was not saved`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busyName = null;
    }
  }

  function saveDraft(field: AppConfigState) {
    const draft = drafts.get(field.name);
    if (draft === undefined) return;
    const parsed = parseConfigDraft(field, draft);
    if (parsed.problem === null) void save(field, parsed.value);
  }
</script>

<ManageHeading title="Config" description="The settings the app declares. The app and its UI read the values, and a change applies at once." />

<ManageSectionState
  count={config?.length}
  error={appsStore.stateErrorFor(serverId, app.id)}
  empty="This app declares no config."
  onRetry={() => void appsStore.loadState(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="app-config">
    {#each config ?? [] as field (field.name)}
      {@const draft = drafts.get(field.name)}
      {@const problem = draft === undefined ? null : parseConfigDraft(field, draft).problem}
      {@const hint = configRangeHint(field)}
      <li class="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/50 px-3 py-2">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span id="app-config-{field.name}" class="min-w-0 truncate font-medium">{field.label}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{field.isDefault ? "Default" : `Default: ${configDefaultText(field)}`}</span>
          {#if field.type === "boolean"}
            <Switch
              class="ml-auto"
              checked={field.value === true}
              disabled={busyName !== null}
              aria-labelledby="app-config-{field.name}"
              onCheckedChange={(checked) => void save(field, checked)}
            />
          {/if}
        </div>
        {#if field.description}
          <p class="m-0 text-xs text-muted-foreground text-pretty">{field.description}</p>
        {/if}
        {#if field.type === "choice" || field.type === "model"}
          <div class="flex flex-wrap items-center gap-2">
            <SettingsSelect
              compact
              ariaLabel={field.label}
              options={field.type === "model" ? modelSettingOptions(hostModels, String(field.value)) : field.options}
              value={String(field.value)}
              disabled={busyName !== null}
              onSelect={(value) => void save(field, value)}
            />
            {#if !field.isDefault}
              <Button size="xs" variant="outline" disabled={busyName !== null} onclick={() => void save(field, null)}>Reset</Button>
            {/if}
          </div>
        {:else if field.type === "text" || field.type === "number"}
          <div class="flex flex-wrap items-start gap-2">
            {#if field.type === "text" && field.multiline}
              <Textarea
                class="min-h-16 w-96 max-w-full"
                aria-labelledby="app-config-{field.name}"
                disabled={busyName !== null}
                value={draft ?? String(field.value)}
                oninput={(event) => drafts.set(field.name, event.currentTarget.value)}
              />
            {:else}
              <Input
                type={field.type === "number" ? "number" : "text"}
                autocomplete="off"
                class="h-7 w-72 max-w-full"
                aria-labelledby="app-config-{field.name}"
                aria-invalid={problem !== null}
                disabled={busyName !== null}
                value={draft ?? String(field.value)}
                oninput={(event) => drafts.set(field.name, event.currentTarget.value)}
                onSubmit={() => saveDraft(field)}
              />
            {/if}
            <Button size="xs" disabled={busyName !== null || draft === undefined || problem !== null} onclick={() => saveDraft(field)}>Save</Button>
            {#if !field.isDefault}
              <Button size="xs" variant="outline" disabled={busyName !== null} onclick={() => void save(field, null)}>Reset</Button>
            {/if}
          </div>
          {#if problem}
            <p class="m-0 text-xs text-(--destructive)" role="alert">{problem}</p>
          {:else if hint}
            <p class="m-0 text-xs text-muted-foreground">{hint}</p>
          {/if}
        {:else if field.type === "boolean" && !field.isDefault}
          <div>
            <Button size="xs" variant="outline" disabled={busyName !== null} onclick={() => void save(field, null)}>Reset</Button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</ManageSectionState>
