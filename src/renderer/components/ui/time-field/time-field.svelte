<!-- shadcn-svelte ships no time picker, so this is the stock field look applied
     to the bits-ui segmented TimeField the rest of the primitives are built on.
     It replaces `<input type="time">`, whose inner chrome is drawn by the
     browser: the segments, the separator and the AM/PM box could never take our
     type scale, focus wash or dark scheme, and each engine drew them its own
     way. Here every segment is our own element, so the field looks the same in
     the desktop shell and in a browser, and each part is arrow-key editable. -->

<script lang="ts">
	import { TimeField as TimeFieldPrimitive } from "bits-ui";
	import { cn } from "@renderer/lib/utils.js";
	import { formatClock, parseClock } from "./clock.js";

	interface Props {
		/** 24-hour `HH:MM`, whatever face the locale shows. */
		value: string;
		onChange: (value: string) => void;
		id?: string;
		label?: string;
		disabled?: boolean;
		/** Omit to follow the locale; pin it where a stored value must read back literally. */
		hourCycle?: 12 | 24;
		class?: string;
	}

	let {
		value,
		onChange,
		id,
		label = "Time",
		disabled = false,
		hourCycle,
		class: className,
	}: Props = $props();

	const time = $derived(parseClock(value));
</script>

<TimeFieldPrimitive.Root
	value={time}
	onValueChange={(next) => {
		if (next) onChange(formatClock(next));
	}}
	granularity="minute"
	{hourCycle}
	{disabled}
>
	<TimeFieldPrimitive.Input
		{id}
		data-slot="time-field"
		aria-label={label}
		class={cn(
			"border-input focus-within:border-ring focus-within:ring-ring/50 h-8 rounded-lg border bg-transparent px-2 text-sm tabular-nums transition-colors focus-within:ring-3 inline-flex w-fit items-center outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-invalid:border-destructive pointer-coarse:h-10",
			className
		)}
	>
		{#snippet children({ segments })}
			{#each segments as segment, index (index)}
				<TimeFieldPrimitive.Segment
					part={segment.part}
					class="rounded-[0.25rem] px-0.5 outline-none transition-colors focus:bg-(--solus-accent-light) focus:text-foreground data-[segment=dayPeriod]:ml-0.5 data-[segment=literal]:px-0 data-[segment=literal]:text-muted-foreground aria-[valuetext=Empty]:text-muted-foreground pointer-coarse:px-1.5 pointer-coarse:py-1"
				>
					{segment.value}
				</TimeFieldPrimitive.Segment>
			{/each}
		{/snippet}
	</TimeFieldPrimitive.Input>
</TimeFieldPrimitive.Root>
