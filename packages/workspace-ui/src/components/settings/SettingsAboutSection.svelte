<script lang="ts">
  import { hostUpdatesStore } from '../../contexts/updates/host-updates.store.svelte';
  import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry';
  import { providerSummary } from '../connections/lib/host-update-rows';
  import { connectionsNav } from '../connections/connections-nav.svelte';
  import { getWorkspaceContext } from '../../contexts';
  const session = getWorkspaceContext();
  function openProviders() {
    session.showSettings('api-access', 'click');
    connectionsNav.open(LOCAL_SERVER_ID, 'providers');
  }

  /** About Solus: the running version and, on desktop, the update status with
   *  its commands. Web and mobile show the version row only; a browser cannot
   *  replace the binary that serves it (`docs/plans/desktop-updates.md`). */
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { CLIENT_VERSION } from "@solus/client-core/version-skew";
  import { updatesStore } from "../../contexts";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import { githubMarkdownExtensions } from "../../lib/githubMarkdown";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { updateCommandFor, updateStatusLine } from "./lib/update-status-text";

  interface Props {
    visible?: boolean;
  }

  let { visible = true }: Props = $props();

  const version = $derived(updatesStore.currentVersion ?? CLIENT_VERSION);
  const state = $derived(updatesStore.state);
  const command = $derived(updateCommandFor(state));
  const releaseNotes = $derived(updatesStore.release?.releaseNotes ?? null);

  function runCommand() {
    if (!command) return;
    if (command.command === "check") void updatesStore.check();
    else if (command.command === "download") void updatesStore.download();
    else updatesStore.restart();
  }
</script>

<SettingsSection label="About Solus" {visible}>
  <SettingsRow label="Version" description={`Solus ${version}`} bodyVisible={updatesStore.isAvailable}>
    {#snippet control()}
      {#if updatesStore.isAvailable && command}
        <Button
          variant={command.command === "restart" ? "default" : "outline"}
          size="sm"
          onclick={runCommand}
        >
          {command.label}
        </Button>
      {/if}
    {/snippet}
    {#snippet body()}
      <div class="flex flex-col gap-3">
        <div
          class="text-[0.875em] text-muted-foreground"
          aria-live="polite"
        >
          {updateStatusLine(state)}
        </div>
        {#if state.kind === "downloading"}
          <div
            class="h-1 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.percent)}
          >
            <div
              class="h-full rounded-full bg-(--solus-accent) transition-[width] duration-300"
              style="width:{Math.max(2, state.percent)}%"
            ></div>
          </div>
        {/if}
        {#if releaseNotes}
          <details class="group">
            <summary
              class="cursor-pointer select-none text-[0.875em] font-medium text-(--solus-text-primary)"
            >
              Release notes for {updatesStore.release?.version}
            </summary>
            <div class="github-markdown prose-cloud mt-2 text-[0.875em]">
              <SvelteMarkdown
                source={releaseNotes}
                extensions={githubMarkdownExtensions}
                renderers={githubMarkdownRenderers}
                sanitizeUrl={remoteMarkdownSanitizeUrl}
              />
            </div>
          </details>
        {/if}
      </div>
    {/snippet}
  </SettingsRow>
  {#if updatesStore.isAvailable}
    <SettingsRow label="Coding providers" description={providerSummary(hostUpdatesStore.hostUpdateFor(LOCAL_SERVER_ID))}>
      {#snippet control()}<Button variant="outline" size="sm" onclick={openProviders}>Show providers</Button>{/snippet}
    </SettingsRow>
  {/if}
  <SettingsRow
    label="Download updates automatically"
    description="Fetch a new version as soon as it is found. You still choose when to restart."
    visible={updatesStore.isAvailable}
  >
    {#snippet control()}
      <Switch
        checked={updatesStore.autoDownload}
        onCheckedChange={(next) => void updatesStore.setAutoDownload(next)}
        size="default"
        aria-label="Toggle automatic update downloads"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>
