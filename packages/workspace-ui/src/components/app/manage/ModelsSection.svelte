<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronRight as OpenIcon } from "@lucide/svelte";
  import type { AppModelCallState } from "@solus/contracts/app-models";
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";
  import ManageHeading from "./ManageHeading.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import ModelCallDetail from "./ModelCallDetail.svelte";
  import { appTime } from "../lib/app-view";
  import { MODEL_CALL_STATE_CHOICES, modelCallStateLabel } from "./lib/model-calls";

  /**
   * The app's model calls (docs/plans/app-models.md §7), the newest first,
   * with a filter on the state. A row opens the call: what the model wrote,
   * the operations it called, and its result. The model of each setting is in
   * the Config section.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    state: AppState | undefined;
  }
  let { serverId, app, state: appState }: Props = $props();

  let stateFilter = $state<AppModelCallState | "">(untrack(() => appsStore.modelCalls.queryFor(serverId, app.id).status ?? ""));
  let openCallId = $state<string | null>(null);

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    const query = stateFilter ? { status: stateFilter } : {};
    return untrack(() => appsStore.modelCalls.watch(hostId, appId, query));
  });
  const calls = $derived(appsStore.modelCalls.get(serverId, app.id));
  const declaresModel = $derived(appState?.descriptor?.config.some((field) => field.type === "model") ?? false);
</script>

<ManageHeading title="Models" description="The app's calls to a model: what each one asked, what the model wrote, and its result. Choose the model of each setting in Config.">
  {#snippet actions()}
    <SettingsSelect compact ariaLabel="Model call state" options={MODEL_CALL_STATE_CHOICES} value={stateFilter} onSelect={(next) => (stateFilter = next)} />
  {/snippet}
</ManageHeading>

<ManageSectionState
  count={calls?.length}
  error={appsStore.modelCalls.errorFor(serverId, app.id)}
  empty={stateFilter ? "No model call is in this state." : declaresModel || !appState ? "This app has made no model call yet." : "This app declares no model setting."}
  onRetry={() => void appsStore.modelCalls.load(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border/50 p-0" data-testid="app-model-calls">
    {#each calls ?? [] as call (call.id)}
      {@const isOpen = openCallId === call.id}
      <li class="flex min-w-0 flex-col border-b border-border/40 last:border-b-0">
        <button
          type="button"
          class="flex min-h-9 w-full min-w-0 cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 overflow-hidden border-0 bg-transparent px-3 py-2 text-left text-xs transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none pointer-coarse:min-h-11"
          aria-expanded={isOpen}
          data-testid="app-model-call-row"
          onclick={() => (openCallId = isOpen ? null : call.id)}
        >
          <OpenIcon size={12} class="shrink-0 self-center text-muted-foreground transition-transform duration-150 {isOpen ? 'rotate-90' : ''}" aria-hidden="true" />
          <code class="min-w-0 shrink truncate font-mono text-(--solus-text-primary)">{call.setting}</code>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{call.model ?? ""}</span>
          <span class="shrink-0 {call.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{modelCallStateLabel(call.status)}</span>
          <span class="w-20 shrink-0 truncate text-right tabular-nums text-muted-foreground" title={new Date(call.createdAt).toLocaleString()}>{appTime(call.createdAt)}</span>
        </button>
        {#if call.error && !isOpen}
          <p class="m-0 truncate px-3 pb-2 pl-8 text-xs text-destructive" title={call.error}>{call.error}</p>
        {/if}
        {#if isOpen}
          <ModelCallDetail {serverId} appId={app.id} callId={call.id} />
        {/if}
      </li>
    {/each}
  </ul>
</ManageSectionState>
