<script lang="ts">
  /**
   * "Six keys worth learning." The caps are drawn from the live binding table
   * rather than typed in, so a rebound shortcut teaches the combo the app
   * actually answers to. Pressing one here lights it: onboarding holds an
   * exclusive keybinding scope, so the real command never fires behind the
   * overlay while the user is trying the keys out.
   */
  import { getKeybindingsContext } from "../../lib/keybindings/dispatcher.svelte";
  import { KEYBINDINGS, type BindingId } from "../../lib/keybindings/manifest";
  import {
    defaultCombo,
    eventMatches,
    formatCombo,
  } from "../../lib/keybindings/match";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import { ONBOARDING_KEYS } from "./lib/onboarding-model";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  const keybindings = getKeybindingsContext();

  let pressed = $state<Partial<Record<BindingId, boolean>>>({});

  const keys = $derived(
    ONBOARDING_KEYS.map((key) => ({
      ...key,
      combo: keybindings.overrides[key.id] ?? defaultCombo(KEYBINDINGS[key.id]),
    })),
  );
  const triedCount = $derived(keys.filter((key) => pressed[key.id]).length);
  const helpCombo = $derived(
    formatCombo(
      keybindings.overrides["global.show-shortcuts"] ??
        defaultCombo(KEYBINDINGS["global.show-shortcuts"]),
    ).join(""),
  );

  const title = $derived(
    triedCount === 0
      ? "Six keys worth learning"
      : triedCount < keys.length
        ? `${triedCount} of ${keys.length} tried`
        : "That is all of them",
  );

  function onKeydown(event: KeyboardEvent) {
    const hit = keys.find((key) => eventMatches(event, key.combo));
    if (!hit) return;
    event.preventDefault();
    pressed[hit.id] = true;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-[1.5rem] font-medium leading-[1.12] sm:text-[1.5rem]"
  >
    {title}
  </h1>
  <p
    class="onboarding-title mt-3 max-w-[34ch] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    Press one now and it lights up. The full list is under {helpCombo} whenever
    you need it.
  </p>

  <!-- Two columns from `sm` up: six of the arrival stages' 72px rows stacked
       would push the actions off a laptop screen. -->
  <div
    class="mt-8 grid w-full max-w-[28.25rem] shrink-0 gap-2.5 sm:mt-10 sm:max-w-[36rem] sm:grid-cols-2"
  >
    {#each keys as key, index (key.id)}
      {@const lit = !!pressed[key.id]}
      <div
        class="onboarding-enter flex min-h-[4.5rem] items-center gap-3.5 rounded-lg px-4 py-3 transition-[background-color,transform] duration-200"
        style="animation-delay: {index * 0.05}s; {lit
          ? 'background: color-mix(in oklch, var(--primary) 10%, transparent); transform: translate3d(0, -2px, 0)'
          : 'background: var(--wash-1)'}"
      >
        <span
          class="flex h-10 shrink-0 items-center justify-center rounded-full px-3 font-mono text-xs transition-[background-color,color] duration-200"
          style="min-width: 2.5rem; {lit
            ? 'background: color-mix(in oklch, var(--primary) 20%, transparent); color: color-mix(in oklch, var(--primary) 68%, var(--foreground))'
            : 'background: var(--wash-2); color: var(--muted-foreground)'}"
        >
          {formatCombo(key.combo).join("")}
        </span>
        <span class="flex min-w-0 flex-col gap-1">
          <span class="text-sm font-medium "
            >{key.label}</span
          >
          <span
            class="truncate text-[0.8125rem] text-muted-foreground"
            >{key.hint}</span
          >
        </span>
      </div>
    {/each}
  </div>

  <OnboardingStageActions
    continueLabel="Continue"
    continueEnabled
    oncontinue={() => store.advance()}
    onback={() => store.back()}
    onskip={() => store.advance()}
  />
</div>
