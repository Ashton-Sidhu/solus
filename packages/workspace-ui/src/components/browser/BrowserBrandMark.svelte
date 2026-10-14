<script lang="ts">
  import type { BrowserCookieBrowser } from "@solus/contracts/browser-types";
  import ChromeLogo from "./logos/ChromeLogo.svelte";
  import FirefoxLogo from "./logos/FirefoxLogo.svelte";
  import SafariLogo from "./logos/SafariLogo.svelte";

  /** The logo of a browser Solus can import cookies from. It is decoration:
   *  the words beside it name the browser. */

  interface Props {
    browser: BrowserCookieBrowser;
    class?: string;
  }

  let { browser, class: className = "" }: Props = $props();
</script>

{#if browser === "chrome"}
  <ChromeLogo class={className} />
{:else if browser === "safari"}
  <SafariLogo class={className} />
{:else}
  <FirefoxLogo class={className} />
{/if}
