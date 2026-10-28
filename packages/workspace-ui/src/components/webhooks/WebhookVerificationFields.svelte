<script lang="ts">
  /** The verification settings of a webhook (docs/plans/webhooks.md §3.7): plain
   *  fields with no defaults. The secret is never read back from the host. */
  import { ShieldAlert as ShieldAlertIcon } from "@lucide/svelte";
  import { Input } from "../ui/input";
  import { Textarea } from "../ui/textarea";
  import { Switch } from "../ui/switch";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import WebhookValueSourceFields from "./WebhookValueSourceFields.svelte";
  import {
    HMAC_ALGORITHMS,
    needsSecret,
    PUBLIC_KEY_ALGORITHMS,
    schemeLabel,
    SCHEMES,
    UNVERIFIED_WARNING,
    type VerificationDraft,
  } from "./lib/webhook-draft";

  let {
    verification = $bindable(),
    hasStoredSecret = false,
    disabled = false,
  }: {
    verification: VerificationDraft;
    /** A saved webhook with this scheme: an empty secret field keeps its secret. */
    hasStoredSecret?: boolean;
    disabled?: boolean;
  } = $props();

  const schemeChoices: { value: VerificationDraft["scheme"]; label: string }[] = [
    { value: "", label: "Choose" },
    ...SCHEMES.map((scheme) => ({ value: scheme, label: schemeLabel(scheme) })),
  ];
  const algorithmChoices = $derived([
    { value: "", label: "Choose" },
    ...(verification.scheme === "public_key" ? PUBLIC_KEY_ALGORITHMS : HMAC_ALGORITHMS).map((algorithm) => ({ value: algorithm, label: algorithm })),
  ]);
  const encodingChoices: { value: VerificationDraft["signatureEncoding"]; label: string }[] = [{ value: "", label: "Choose" }, { value: "hex", label: "Hex" }, { value: "base64", label: "Base64" }];
  const secretEncodingChoices: { value: VerificationDraft["secretEncoding"]; label: string }[] = [{ value: "", label: "Choose" }, { value: "text", label: "Text" }, { value: "base64", label: "Base64" }];
  const signed = $derived(verification.scheme === "hmac" || verification.scheme === "public_key");
</script>

<div class="flex flex-col gap-3">
  <div class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">Scheme</span>
    <SettingsSelect compact ariaLabel="Verification scheme" options={schemeChoices} value={verification.scheme} {disabled} onSelect={(scheme) => (verification.scheme = scheme)} />
  </div>

  {#if signed}
    <div class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Algorithm</span>
      <SettingsSelect compact ariaLabel="Algorithm" options={algorithmChoices} value={verification.algorithm} {disabled} onSelect={(algorithm) => (verification.algorithm = algorithm)} />
    </div>
    {#if verification.scheme === "public_key"}
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Public key</span>
        <Textarea bind:value={verification.publicKey} {disabled} dictation={false} rows={3} class="font-mono text-xs" aria-label="Public key" />
      </label>
    {/if}
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Signed text, for example {"{{body}}"} or {"{{headers.x-timestamp}}:{{body}}"}</span>
      <Input bind:value={verification.signedText} {disabled} class="h-7 font-mono text-xs" aria-label="Signed text" />
    </label>
    <WebhookValueSourceFields bind:source={verification.signatureSource} label="Signature" {disabled} />
    <div class="flex flex-wrap items-end gap-2">
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Signature encoding</span>
        <SettingsSelect compact ariaLabel="Signature encoding" options={encodingChoices} value={verification.signatureEncoding} {disabled} onSelect={(encoding) => (verification.signatureEncoding = encoding)} />
      </div>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Prefix (optional)</span>
        <Input bind:value={verification.signaturePrefix} {disabled} class="h-7 w-28 font-mono text-xs" aria-label="Signature prefix" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">List separator (optional)</span>
        <Input bind:value={verification.signatureListSeparator} {disabled} class="h-7 w-28 font-mono text-xs" aria-label="Signature list separator" />
      </label>
    </div>
    <label class="flex items-center gap-2 text-sm">
      <Switch bind:checked={verification.hasTimestamp} {disabled} aria-label="Check a timestamp" />
      Check a timestamp. An old request fails.
    </label>
    {#if verification.hasTimestamp}
      <WebhookValueSourceFields bind:source={verification.timestampSource} label="Timestamp" {disabled} />
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Tolerance in seconds</span>
        <Input bind:value={verification.timestampTolerance} type="number" min={1} max={86400} {disabled} class="h-7 w-28 tabular-nums" aria-label="Timestamp tolerance in seconds" />
      </label>
    {/if}
  {/if}

  {#if verification.scheme === "token" || verification.scheme === "jwt"}
    <WebhookValueSourceFields bind:source={verification.source} label="Token" {disabled} />
  {/if}
  {#if verification.scheme === "jwt"}
    <div class="flex flex-wrap gap-2">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Issuer</span>
        <Input bind:value={verification.issuer} {disabled} class="h-7 w-56" aria-label="Issuer" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Audience</span>
        <Input bind:value={verification.audience} {disabled} class="h-7 w-56" aria-label="Audience" />
      </label>
    </div>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">JWKS URL</span>
      <Input bind:value={verification.jwksUrl} type="url" {disabled} class="h-7" aria-label="JWKS URL" />
    </label>
  {/if}

  {#if needsSecret(verification.scheme)}
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">
          {hasStoredSecret ? "Secret (empty keeps the saved secret)" : "Secret"}
        </span>
        <Input bind:value={verification.secret} type="password" autocomplete="off" {disabled} class="h-7 w-72" aria-label="Secret" />
      </label>
      {#if verification.scheme !== "standard_webhooks"}
        <div class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Secret encoding</span>
          <SettingsSelect compact ariaLabel="Secret encoding" options={secretEncodingChoices} value={verification.secretEncoding} {disabled} onSelect={(encoding) => (verification.secretEncoding = encoding)} />
        </div>
      {/if}
    </div>
  {/if}

  {#if verification.scheme === "none"}
    <p class="flex items-start gap-1.5 text-sm text-destructive">
      <ShieldAlertIcon size={14} class="mt-0.5 shrink-0" />{UNVERIFIED_WARNING}
    </p>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Name the sender, and say why it cannot sign its requests or send a header.</span>
      <Textarea bind:value={verification.reason} {disabled} rows={2} aria-label="Reason for no verification" />
    </label>
  {/if}
</div>
