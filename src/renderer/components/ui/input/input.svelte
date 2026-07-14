<!-- DIVERGED FROM STOCK: Solus field dictation and submit behavior lives here. -->
<script lang="ts">
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";
	import { cn, type WithElementRef } from "@renderer/lib/utils.js";
	import { createFieldDictation, type FieldSubmitKey } from "@renderer/lib/field-dictation.svelte.js";
	import RecordingControls from "../../input/RecordingControls.svelte";

	type InputType = Exclude<HTMLInputTypeAttribute, "file">;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, "type"> &
			({ type: "file"; files?: FileList } | { type?: InputType; files?: undefined })
	> & {
		dictation?: boolean;
		mic?: boolean;
		vadMinSpeechMs?: number;
		onSubmit?: () => void;
		submitOn?: FieldSubmitKey;
		autofocus?: boolean;
	};

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		class: className,
		"data-slot": dataSlot = "input",
		dictation,
		mic = false,
		vadMinSpeechMs = 0,
		onSubmit,
		submitOn,
		autofocus = false,
		disabled = false,
		onkeydown,
		onfocus,
		onblur,
		...restProps
	}: Props = $props();

	const dictationOn = $derived(
		dictation ?? (type === undefined || ["text", "search", "url", "email"].includes(type))
	);
	const field = createFieldDictation({
		getRef: () => ref,
		getDisabled: () => disabled,
		getEnabled: () => dictationOn,
		getOnSubmit: () => onSubmit,
		getSubmitOn: () => submitOn,
		getVadMinSpeechMs: () => vadMinSpeechMs,
		getOnkeydown: () => onkeydown,
		getOnfocus: () => onfocus,
		getOnblur: () => onblur,
	});

	$effect(() => {
		if (autofocus) ref?.focus({ preventScroll: true });
	});
</script>

{#if type === "file"}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-input/50 dark:disabled:bg-input/80 h-8 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors file:h-6 file:text-sm file:font-medium focus-visible:ring-3 aria-invalid:ring-3 md:text-sm file:text-foreground placeholder:text-muted-foreground w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
			className
		)}
		type="file"
		bind:files
		bind:value
		{disabled}
		{onkeydown}
		{onfocus}
		{onblur}
		{...restProps}
	/>
{:else if dictationOn}
	<span data-slot="input-wrap" class="relative flex w-full min-w-0 items-center" class:min-h-6={field.micState === "recording"}>
		<input
			bind:this={ref}
			data-slot={dataSlot}
			class={cn(
				"dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-input/50 dark:disabled:bg-input/80 h-8 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors file:h-6 file:text-sm file:font-medium focus-visible:ring-3 aria-invalid:ring-3 md:text-sm file:text-foreground placeholder:text-muted-foreground w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
				mic && "pr-8",
				field.micState === "recording" && "invisible pointer-events-none",
				className
			)}
			{type}
			bind:value
			{disabled}
			onkeydown={field.handleKeydown}
			onfocus={field.handleFocus}
			onblur={field.handleBlur}
			{...restProps}
		/>
		<RecordingControls
			variant="field"
			state={field.micState}
			rmsRef={field.rmsRef}
			showMic={mic}
			disabled={field.micDisabled}
			idleTooltip={field.idleMicTooltip}
			progressPct={field.progressPct}
			onCancel={field.cancel}
			onConfirm={field.confirm}
			onToggle={field.toggle}
		/>
	</span>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-input/50 dark:disabled:bg-input/80 h-8 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors file:h-6 file:text-sm file:font-medium focus-visible:ring-3 aria-invalid:ring-3 md:text-sm file:text-foreground placeholder:text-muted-foreground w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
			className
		)}
		{type}
		bind:value
		{disabled}
		{onkeydown}
		{onfocus}
		{onblur}
		{...restProps}
	/>
{/if}
