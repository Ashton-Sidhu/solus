<!-- DIVERGED FROM STOCK: Solus field dictation and submit behavior lives here. -->
<script lang="ts">
	import type { HTMLTextareaAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "@renderer/lib/utils.js";
	import { createFieldDictation, type FieldSubmitKey } from "@renderer/lib/field-dictation.svelte.js";
	import RecordingControls from "../../input/RecordingControls.svelte";

	type Props = WithElementRef<HTMLTextareaAttributes, HTMLTextAreaElement> & {
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
		class: className,
		"data-slot": dataSlot = "textarea",
		dictation = true,
		mic = false,
		vadMinSpeechMs = 0,
		onSubmit,
		submitOn,
		autofocus = false,
		disabled = false,
		rows = 1,
		onkeydown,
		onfocus,
		onblur,
		...restProps
	}: Props = $props();

	const field = createFieldDictation({
		getRef: () => ref,
		getDisabled: () => disabled,
		getEnabled: () => dictation,
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

{#if dictation}
	<span data-slot="textarea-wrap" class="relative flex w-full min-w-0 items-center" class:min-h-6={field.micState === "recording"}>
		<textarea
			bind:this={ref}
			data-slot={dataSlot}
			class={cn(
				"border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 field-sizing-content min-h-16 w-full resize-none rounded-lg border bg-transparent! px-2.5 py-2 text-xs! leading-4! placeholder:text-xs! placeholder:leading-[1.125rem]! shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-3 disabled:bg-transparent! dark:bg-transparent! dark:disabled:bg-transparent! disabled:cursor-not-allowed disabled:opacity-50",
				mic && "pr-8",
				field.micState === "recording" && "invisible pointer-events-none",
				className
			)}
			bind:value
			{disabled}
			{rows}
			onkeydown={field.handleKeydown}
			onfocus={field.handleFocus}
			onblur={field.handleBlur}
			{...restProps}
		></textarea>
		<RecordingControls
			variant="field"
			state={field.micState}
			rmsRef={field.rmsRef}
			showMic={mic}
			micTextarea={rows > 1}
			disabled={field.micDisabled}
			idleTooltip={field.idleMicTooltip}
			progressPct={field.progressPct}
			onCancel={field.cancel}
			onConfirm={field.confirm}
			onToggle={field.toggle}
		/>
	</span>
{:else}
	<textarea
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 field-sizing-content min-h-16 w-full resize-none rounded-lg border bg-transparent! px-2.5 py-2 text-xs! leading-4! placeholder:text-xs! placeholder:leading-[1.125rem]! shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-3 disabled:bg-transparent! dark:bg-transparent! dark:disabled:bg-transparent! disabled:cursor-not-allowed disabled:opacity-50",
			className
		)}
		bind:value
		{disabled}
		{rows}
		{onkeydown}
		{onfocus}
		{onblur}
		{...restProps}
	></textarea>
{/if}
