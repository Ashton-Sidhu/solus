<script lang="ts">
  import { CircleCheck } from "@lucide/svelte";
  import { BROWSER_COOKIE_BROWSERS } from "@solus/contracts/browser-types";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { Button } from "../ui/button";
  import BrowserBrandMark from "./BrowserBrandMark.svelte";
  import BrowserCookieImport from "./BrowserCookieImport.svelte";
  import { offersCookieImport } from "./lib/profiles";

  /**
   * The offer to import cookies, made when the browser opens with no page. It
   * asks the host first and appears only when a browser there has cookies to
   * import, so it never leads to "Nothing to import". The import itself is the
   * same consented flow the profile chip opens (ADR 0025, 0026).
   */

  interface Props {
    serverId: string;
    projectRoot: string | undefined;
    profileId: string;
    profileName: string;
    /** `remember` is true when the prompt must not come back on this device:
     *  the user pressed "Don't show again" or went on to import. */
    onClose: (remember: boolean) => void;
  }

  let { serverId, projectRoot, profileId, profileName, onClose }: Props =
    $props();

  let isOffered = $state(false);
  let importing = $state(false);

  $effect(() => {
    let current = true;
    // A failed scan is not the user's problem here: the prompt stays away and
    // the profile chip still offers the import.
    void browserStore
      .cookieSources(serverId)
      .then((scan) => {
        if (current) isOffered = offersCookieImport(scan);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });
</script>

{#if isOffered}
  <!-- Escape belongs on the dialog itself, as on the close confirmation: a key
       spent here must not also close the pane. -->
  <div
    class="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 dark:bg-black/55"
    role="presentation"
    onkeydown={(event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose(importing);
    }}
  >
    <div
      class="text-workspace-chrome flex max-h-full w-[min(30rem,100%)] flex-col overflow-y-auto rounded-2xl bg-[var(--popover)] shadow-[shadow:0_0_0_0.5px_var(--hairline-strong),0_0.75rem_2rem_-0.75rem_rgba(0,0,0,0.3)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150 {importing
        ? 'p-1.5'
        : 'px-7 pt-7 pb-6'}"
      role="dialog"
      aria-modal="true"
      aria-labelledby={importing ? undefined : "browser-cookie-prompt-title"}
      aria-label={importing ? "Import cookies" : undefined}
    >
      {#if importing}
        <BrowserCookieImport
          {serverId}
          {projectRoot}
          {profileId}
          {profileName}
          backLabel="Close"
          onBack={() => onClose(true)}
        />
      {:else}
        <div class="flex flex-col items-center text-center">
          <!-- Every browser Solus reads, not only the ones found: the row says
               where cookies can come from. -->
          <div class="flex items-center gap-3">
            {#each BROWSER_COOKIE_BROWSERS as browser (browser)}
              <BrowserBrandMark {browser} class="size-10" />
            {/each}
          </div>
          <h2
            id="browser-cookie-prompt-title"
            class="mt-5 text-[1.375rem] leading-tight font-semibold tracking-normal text-(--solus-text-primary)"
          >
            Stay signed in to your sites
          </h2>
          <p class="mt-2 leading-relaxed text-pretty text-(--solus-text-secondary)">
            Import cookies from your browser so your sites open signed in. Agents
            that use <span class="font-medium text-(--solus-text-primary)"
              >{profileName}</span
            > are signed in too.
          </p>
        </div>

        <ul class="mt-6 flex flex-col gap-3.5 text-(--solus-text-secondary)">
          <li class="flex items-center gap-3">
            <CircleCheck
              class="size-4 shrink-0 text-(--solus-text-tertiary)"
              aria-hidden="true"
            />
            <span>Cookies only. Passwords are not imported.</span>
          </li>
          <li class="flex items-center gap-3">
            <CircleCheck
              class="size-4 shrink-0 text-(--solus-text-tertiary)"
              aria-hidden="true"
            />
            <span>You choose the browser profile.</span>
          </li>
          <li class="flex items-center gap-3">
            <CircleCheck
              class="size-4 shrink-0 text-(--solus-text-tertiary)"
              aria-hidden="true"
            />
            <span>Cookies stay on the computer that runs Solus.</span>
          </li>
        </ul>

        <div class="mt-7 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="mr-auto rounded-sm text-(--solus-text-tertiary) underline decoration-(--hairline-strong) underline-offset-4 transition-colors hover:text-(--solus-text-secondary) hover:decoration-current"
            onclick={() => onClose(true)}
          >
            Don’t show again
          </button>
          <Button
            variant="outline"
            class="h-8.5 px-3.5 font-normal"
            onclick={() => onClose(false)}
          >
            Not now
          </Button>
          <!-- svelte-ignore a11y_autofocus -->
          <Button
            class="h-8.5 bg-[color:var(--solus-text-primary)] px-3.5 text-[color:var(--solus-container-bg)] hover:opacity-85"
            autofocus
            onclick={() => (importing = true)}
          >
            Import cookies
          </Button>
        </div>
      {/if}
    </div>
  </div>
{/if}
