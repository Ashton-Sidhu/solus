<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { getSettingsContext, taskSourcesStore } from "../../../contexts";
  import { PAGE_PRIMARY_BTN } from "../../../lib/page-chrome";
  import { Checkbox } from "../../ui/checkbox";
  import { SourceLogo } from "../../ui/list-page";
  import { projectSourceOffers, withTaskSources, type ProjectSourceOffer } from "./lib/task-source-setup";
  import { saveTaskSources } from "./lib/save-task-sources.svelte";

  /**
   * The repositories of the person's recent projects, offered in one step to a
   * person with no task source (docs/tasks.md). Each is selected, except a
   * fork's original repository. Added, they are ordinary sources.
   */
  interface Props {
    offers: ProjectSourceOffer[];
    /** Called after the sources are added, so the page reads their tasks. */
    onChanged?: () => void;
  }
  let { offers, onChanged }: Props = $props();

  const settings = getSettingsContext();
  /** The person's own choice for an offer; unset follows its default. */
  const choices = new SvelteMap<string, boolean>();
  const isChosen = (offer: ProjectSourceOffer) => choices.get(offer.sourceKey) ?? !offer.isFork;
  const chosen = $derived(offers.filter(isChosen));

  function addChosen() {
    const config = { taskSources: settings.taskSources };
    if (saveTaskSources(settings, withTaskSources(config, chosen.map((offer) => offer.source)))) onChanged?.();
  }
</script>

<div class="grid w-[min(24rem,100%)] gap-3 text-left">
  <ul class="m-0 grid list-none gap-0.5 rounded-xl bg-(--solus-surface-hover) p-1" aria-label="Your projects' repositories">
    {#each offers as offer (offer.sourceKey)}
      <li>
        <label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-workspace-chrome text-(--solus-text-secondary) transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground pointer-coarse:py-3">
          <Checkbox checked={isChosen(offer)} onCheckedChange={(checked) => choices.set(offer.sourceKey, checked === true)} />
          <SourceLogo source="github" />
          <span class="min-w-0 flex-1 truncate">{offer.label}</span>
          {#if offer.isFork}
            <span class="shrink-0 text-xs text-(--solus-text-tertiary)" title="This project is a fork. Its original repository has many issues that are rarely yours.">Fork</span>
          {/if}
        </label>
      </li>
    {/each}
  </ul>
  <button type="button" class="{PAGE_PRIMARY_BTN} justify-center" disabled={chosen.length === 0} onclick={addChosen}>
    {chosen.length === 0 ? "Select a repository" : `Add ${chosen.length} ${chosen.length === 1 ? "repository" : "repositories"}`}
  </button>
</div>
