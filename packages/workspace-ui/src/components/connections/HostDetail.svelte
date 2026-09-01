<script lang="ts">
  /** One host, in full. The onboarding rail is for arrival and asks one thing
   *  at a time; this is where a host set up last week can be looked at, and
   *  every part of it changed, in whatever order the user wants. */
  import { serversStore, type ServerItem } from "../../contexts";
  import * as Tabs from "../ui/tabs";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";
  import HostDetailOverview from "./HostDetailOverview.svelte";
  import HostDetailGit from "./HostDetailGit.svelte";
  import HostDetailProviders from "./HostDetailProviders.svelte";
  import HostDetailEnvironment from "./HostDetailEnvironment.svelte";
  import HostDetailAccess from "./HostDetailAccess.svelte";

  interface Props {
    host: ServerItem;
  }

  let { host }: Props = $props();
  let tab = $state("overview");

  const setup = $derived(hostSetupStore.sessionFor(host.id));
  const isActive = $derived(serversStore.activeServer?.id === host.id);

  // Setup events belong to the host, so the page holds its subscription open
  // for as long as it is showing that host — and hands it back on the way out.
  $effect(() => {
    const session = hostSetupStore.sessionFor(host.id);
    session.retain();
    void session.refreshReadiness();
    return () => session.release();
  });

  // What the host is, in its own terms: where it answers and what it runs.
  const meta = $derived(
    [host.url, setup.readiness?.platform].filter(Boolean).join(" · "),
  );
</script>

<div class="flex flex-col gap-6 [.is-laptop-display_&]:gap-5">
  <div class="min-w-0">
    <h2
      class="text-[2em] font-medium text-foreground"
    >
      {host.label}
    </h2>
    <p
      class="mt-1 truncate text-[0.875em] text-muted-foreground"
      style="font-family: 'Geist Mono', ui-monospace, monospace"
    >
      {meta}
    </p>
  </div>

  <Tabs.Root bind:value={tab}>
    <Tabs.List variant="line" class="w-full justify-start gap-4 border-b border-border pb-1 [.is-laptop-display_&]:gap-3">
      <Tabs.Trigger value="overview" class="flex-none px-0">Overview</Tabs.Trigger>
      <Tabs.Trigger value="git" class="flex-none px-0">Git</Tabs.Trigger>
      <Tabs.Trigger value="providers" class="flex-none px-0">AI providers</Tabs.Trigger>
      <Tabs.Trigger value="environment" class="flex-none px-0">Environment</Tabs.Trigger>
      {#if isActive}
        <!-- Access describes the server this client is connected to. On any
             other host it would list the wrong machine's devices under this
             host's name, so it is hidden rather than made to guess. -->
        <Tabs.Trigger value="access" class="flex-none px-0">Access</Tabs.Trigger>
      {/if}
    </Tabs.List>

    <Tabs.Content value="overview" class="mt-5 flex flex-col gap-7 [.is-laptop-display_&]:mt-4 [.is-laptop-display_&]:gap-5">
      <HostDetailOverview {host} {setup} onOpenTab={(next) => (tab = next)} />
    </Tabs.Content>
    <Tabs.Content value="git" class="mt-5 flex flex-col gap-7 [.is-laptop-display_&]:mt-4 [.is-laptop-display_&]:gap-5">
      <HostDetailGit {setup} />
    </Tabs.Content>
    <Tabs.Content value="providers" class="mt-5 flex flex-col gap-7 [.is-laptop-display_&]:mt-4 [.is-laptop-display_&]:gap-5">
      <HostDetailProviders {setup} />
    </Tabs.Content>
    <Tabs.Content value="environment" class="mt-5 flex flex-col gap-7 [.is-laptop-display_&]:mt-4 [.is-laptop-display_&]:gap-5">
      <HostDetailEnvironment {setup} />
    </Tabs.Content>
    {#if isActive}
      <Tabs.Content value="access" class="mt-5 flex flex-col gap-7 [.is-laptop-display_&]:mt-4 [.is-laptop-display_&]:gap-5">
        <HostDetailAccess serverId={host.id} />
      </Tabs.Content>
    {/if}
  </Tabs.Root>
</div>
