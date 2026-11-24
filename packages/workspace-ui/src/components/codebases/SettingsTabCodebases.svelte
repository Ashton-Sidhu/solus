<script lang="ts">
  /** Settings → Codebases (docs/plans/codebases.md §9): the codebases of every
   *  connected host in one list, and the page of one codebase. The open
   *  codebase is the page URL, so a link opens the same view. */
  import { tick, untrack } from "svelte";
  import { Plus as PlusIcon } from "@lucide/svelte";
  import { codebasesStore, getWorkspaceContext } from "../../contexts";
  import { Button } from "../ui/button";
  import { ListEmpty } from "../ui/list-page";
  import { RowCard } from "../ui/row-card";
  import CodebaseDetail from "./CodebaseDetail.svelte";
  import CodebaseListRow from "./CodebaseListRow.svelte";
  import CodebaseNewForm from "./CodebaseNewForm.svelte";
  import { codebaseSummary, NEW_CODEBASE } from "./lib/codebase-view";
  import { codebasesPageRequest } from "./lib/codebases-page-request.svelte";

  const session = getWorkspaceContext();
  /** The codebase the page shows: its id, `new` for the form, or null for the list. */
  const openCodebase = $derived(session.router.params("settings")?.codebase ?? null);

  $effect(() => untrack(() => codebasesStore.watch()));

  let listEl = $state<HTMLElement | null>(null);

  /** Change the view in place: the list and a codebase are one settings page, not steps back. */
  function show(codebase: string | null) {
    session.router.navigate({ name: "settings", params: codebase ? { tab: "codebases", codebase } : { tab: "codebases" } }, { replace: true });
  }

  /** Back to the list, with focus on the row the person came from, else on New codebase. */
  async function showList(fromCodebaseId: string | null) {
    show(null);
    await tick();
    const row = fromCodebaseId ? listEl?.querySelector<HTMLElement>(`[data-codebase-row="${CSS.escape(fromCodebaseId)}"]`) : null;
    (row ?? listEl?.querySelector<HTMLElement>("[data-new-codebase]"))?.focus();
  }

  // The command palette's "New codebase" opens the form, also when the page is open.
  $effect(() => {
    if (!codebasesPageRequest.isNewAsked) return;
    untrack(() => {
      codebasesPageRequest.takeNew();
      show(NEW_CODEBASE);
    });
  });

  const codebases = $derived(codebasesStore.codebases);
  const hosts = $derived(codebasesStore.hosts);
  const readyHosts = $derived(hosts.filter((host) => host.isReady));
  const isLoading = $derived(readyHosts.some((host) => host.status === null || host.status === "loading"));
  const canMake = $derived(readyHosts.some((host) => host.status === "ready"));
  // A host that is away gets the changes later; a host that did not answer keeps none. Each one gets a line.
  const hostNotes = $derived(
    hosts.flatMap((host) => {
      if (!host.isReady) return [{ serverId: host.serverId, text: `${host.label} is not connected. It gets your changes when it connects.` }];
      if (host.status === "unavailable") return [{ serverId: host.serverId, text: `${host.label} did not give its codebases. It can be an older version of Solus.` }];
      return [];
    }),
  );
</script>

{#if openCodebase === NEW_CODEBASE}
  <CodebaseNewForm onClose={() => void showList(null)} onCreated={(codebaseId) => show(codebaseId)} />
{:else if openCodebase}
  {#key openCodebase}
    <CodebaseDetail codebaseId={openCodebase} onClose={() => void showList(openCodebase)} />
  {/key}
{:else}
  <section bind:this={listEl} class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="max-w-xl text-pretty text-workspace-chrome text-muted-foreground">
        A codebase is a named set of two or more folders, on one or more hosts, that one piece of work covers.
      </p>
      <Button data-new-codebase size="sm" variant="outline" class="shrink-0" disabled={!canMake} onclick={() => show(NEW_CODEBASE)}>
        <PlusIcon size={14} /> New codebase
      </Button>
    </div>

    {#each hostNotes as note (note.serverId)}
      <p class="text-workspace-chrome text-muted-foreground">{note.text}</p>
    {/each}

    {#if codebases.length > 0}
      <RowCard>
        {#each codebases as codebase (codebase.id)}
          <CodebaseListRow
            codebaseId={codebase.id}
            name={codebase.name}
            summary={codebaseSummary(codebase, (installationId) => codebasesStore.hostOf(installationId))}
            onOpen={() => show(codebase.id)}
          />
        {/each}
      </RowCard>
    {:else if isLoading}
      <p class="py-6 text-center text-workspace-chrome text-muted-foreground" role="status">Loading codebases…</p>
    {:else if readyHosts.length === 0}
      <ListEmpty title="No host is connected.">Your hosts keep the codebases. Connect a host to see them.</ListEmpty>
    {:else}
      <ListEmpty title="No codebases yet.">
        Make one from two or more folders, to let one session work in each of them.
        {#snippet actions()}
          <Button size="sm" variant="outline" disabled={!canMake} onclick={() => show(NEW_CODEBASE)}>
            <PlusIcon size={14} /> New codebase
          </Button>
        {/snippet}
      </ListEmpty>
    {/if}
  </section>
{/if}
