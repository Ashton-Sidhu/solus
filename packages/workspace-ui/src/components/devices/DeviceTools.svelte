<script lang="ts">
  import type { DeviceAction, DeviceDetail, DevicePlatform, DeviceToggle } from "@solus/contracts/device-types";
  import {
    DEVICE_COLOR_FILTERS,
    DEVICE_ORIENTATIONS,
    DEVICE_TEXT_SIZES,
    deviceSupportedPermissions,
    deviceSupportedToggles,
    deviceSupportsAction,
  } from "@solus/contracts/device-types";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import { toggleLabel, orientationLabel, colorFilterLabel, textSizeLabel } from "./lib/device-tools";

  /**
   * Device settings and app actions (plan 016, P10–P13). Values shown are what
   * the device reported back; a control is pending while its action runs and
   * never shows a value the device did not confirm. Only actions the platform
   * supports are offered.
   */

  interface Props {
    platform: DevicePlatform;
    detail: DeviceDetail | undefined;
    pending: string | null;
    run: (action: DeviceAction) => void;
  }

  let { platform, detail, pending, run }: Props = $props();

  let latitude = $state("");
  let longitude = $state("");
  let appId = $state("");
  let url = $state("");
  let permission = $state("camera");
  let pushText = $state("");

  const settings = $derived(detail?.settings ?? {});
  const supports = (action: DeviceAction) => deviceSupportsAction(platform, action);
  const toggles = $derived(deviceSupportedToggles(platform));
  const permissions = $derived(deviceSupportedPermissions(platform));
  const decisions = $derived(platform === "ios" ? (["grant", "revoke", "reset"] as const) : (["grant", "revoke"] as const));
  const appIdValid = $derived(/^[A-Za-z0-9._-]+$/.test(appId.trim()));

  $effect(() => {
    if (!appId && detail?.foregroundApp) appId = detail.foregroundApp.appId;
  });

  function setLocation() {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    run({ type: "setLocation", latitude: lat, longitude: lon });
  }

  function sendPush() {
    const text = pushText.trim();
    if (!text || !appIdValid) return;
    run({ type: "sendPush", appId: appId.trim(), payload: text.startsWith("{") ? { kind: "json", json: text } : { kind: "text", body: text } });
  }
</script>

<div class="flex max-h-[45%] flex-col gap-4 overflow-y-auto border-t border-[var(--hairline)] px-3 py-3 text-chrome-dense" data-testid="device-tools">
  <section class="flex flex-col gap-2" aria-label="Display">
    <div class="flex items-center justify-between gap-2">
      <span>Appearance</span>
      <div class="flex gap-1" role="group" aria-label="Appearance">
        {#each ["light", "dark"] as const as value (value)}
          <Button size="xs" variant={settings.appearance === value ? "secondary" : "ghost"} aria-pressed={settings.appearance === value}
            disabled={pending === "setAppearance"} onclick={() => run({ type: "setAppearance", value })}>
            {value === "light" ? "Light" : "Dark"}
          </Button>
        {/each}
      </div>
    </div>
    <label class="flex items-center justify-between gap-2">
      <span>Text size</span>
      <select class="rounded-md border border-border bg-background px-2 py-1" value={settings.textSize ?? ""} disabled={pending === "setTextSize"}
        onchange={(event) => run({ type: "setTextSize", value: event.currentTarget.value as (typeof DEVICE_TEXT_SIZES)[number] })}>
        {#if !settings.textSize}<option value="" disabled>Unknown</option>{/if}
        {#each DEVICE_TEXT_SIZES as value (value)}<option {value}>{textSizeLabel(value)}</option>{/each}
      </select>
    </label>
    {#if platform === "android"}
      <label class="flex items-center justify-between gap-2">
        <span>Orientation</span>
        <select class="rounded-md border border-border bg-background px-2 py-1" disabled={pending === "setOrientation"}
          onchange={(event) => run({ type: "setOrientation", value: event.currentTarget.value as (typeof DEVICE_ORIENTATIONS)[number] })}>
          <option value="" selected disabled>Choose…</option>
          {#each DEVICE_ORIENTATIONS as value (value)}<option {value}>{orientationLabel(value)}</option>{/each}
        </select>
      </label>
    {/if}
  </section>

  <section class="flex flex-col gap-2" aria-label="Accessibility">
    {#each toggles as setting (setting)}
      <label class="flex items-center justify-between gap-2">
        <span>{toggleLabel(setting as DeviceToggle)}{settings[setting] === undefined ? " · unknown" : ""}</span>
        <Switch checked={settings[setting] === true} disabled={pending === `setToggle:${setting}`}
          onCheckedChange={(value) => run({ type: "setToggle", setting, value })} aria-label={toggleLabel(setting)} />
      </label>
    {/each}
    {#if platform === "ios"}
      <div class="flex items-center justify-between gap-2">
        <span>Liquid Glass</span>
        <div class="flex gap-1" role="group" aria-label="Liquid Glass">
          {#each ["clear", "tinted"] as const as value (value)}
            <Button size="xs" variant={settings.liquidGlass === value ? "secondary" : "ghost"} aria-pressed={settings.liquidGlass === value}
              disabled={pending === "setLiquidGlass"} onclick={() => run({ type: "setLiquidGlass", value })}>
              {value === "clear" ? "Clear" : "Tinted"}
            </Button>
          {/each}
        </div>
      </div>
      <label class="flex items-center justify-between gap-2">
        <span>Color filter</span>
        <select class="rounded-md border border-border bg-background px-2 py-1" value={settings.colorFilter ?? ""} disabled={pending === "setColorFilter"}
          onchange={(event) => run({ type: "setColorFilter", value: event.currentTarget.value as (typeof DEVICE_COLOR_FILTERS)[number] })}>
          {#if !settings.colorFilter}<option value="" disabled>Unknown</option>{/if}
          {#each DEVICE_COLOR_FILTERS as value (value)}<option {value}>{colorFilterLabel(value)}</option>{/each}
        </select>
      </label>
    {/if}
  </section>

  <section class="flex flex-col gap-2" aria-label="Location">
    <span>Location</span>
    <div class="flex gap-1">
      <input class="w-0 min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1" placeholder="Latitude" inputmode="decimal" bind:value={latitude} aria-label="Latitude" />
      <input class="w-0 min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1" placeholder="Longitude" inputmode="decimal" bind:value={longitude} aria-label="Longitude" />
      <Button size="xs" variant="outline" disabled={pending === "setLocation"} onclick={setLocation}>Set</Button>
      {#if supports({ type: "clearLocation" })}
        <Button size="xs" variant="ghost" disabled={pending === "clearLocation"} onclick={() => run({ type: "clearLocation" })}>Clear</Button>
      {/if}
    </div>
  </section>

  <section class="flex flex-col gap-2" aria-label="App">
    <div class="flex items-center justify-between gap-2">
      <span>App</span>
      <span class="truncate text-muted-foreground">{detail?.foregroundApp ? `Foreground: ${detail.foregroundApp.appId}` : "Foreground app unknown"}</span>
    </div>
    <input class="rounded-md border border-border bg-background px-2 py-1" placeholder="Bundle or package id" bind:value={appId} aria-label="App id" />
    <div class="flex flex-wrap gap-1">
      <Button size="xs" variant="outline" disabled={!appIdValid || pending === "launchApp"} onclick={() => run({ type: "launchApp", appId: appId.trim() })}>Launch</Button>
      <Button size="xs" variant="ghost" disabled={!appIdValid || pending === "terminateApp"} onclick={() => run({ type: "terminateApp", appId: appId.trim() })}>Terminate</Button>
    </div>
    <div class="flex gap-1">
      <select class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1" bind:value={permission} aria-label="Permission">
        {#each permissions as value (value)}<option {value}>{value}</option>{/each}
      </select>
      {#each decisions as decision (decision)}
        <Button size="xs" variant="ghost" disabled={!appIdValid || pending === "setPermission"}
          onclick={() => run({ type: "setPermission", appId: appId.trim(), permission: permission as (typeof permissions)[number], decision })}>
          {decision === "grant" ? "Grant" : decision === "revoke" ? "Revoke" : "Reset"}
        </Button>
      {/each}
    </div>
    <div class="flex gap-1">
      <input class="w-0 min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1" placeholder="myapp://path or https://…" bind:value={url} aria-label="URL to open" />
      <Button size="xs" variant="outline" disabled={!url.trim() || pending === "openUrl"} onclick={() => run({ type: "openUrl", url: url.trim() })}>Open URL</Button>
    </div>
    {#if platform === "ios"}
      <div class="flex gap-1">
        <input class="w-0 min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1" placeholder={'Push text or {"aps":{…}}'} bind:value={pushText} maxlength={4096} aria-label="Test push payload" />
        <Button size="xs" variant="outline" disabled={!appIdValid || !pushText.trim() || pending === "sendPush"} onclick={sendPush}>Send push</Button>
      </div>
    {/if}
  </section>
</div>
