<script lang="ts">
	import { onMount } from 'svelte';

	const sections = [
		{ id: 'overview',    label: 'Overview' },
		{ id: 'keybindings', label: 'Keybindings' },
		{ id: 'panes',       label: 'Workspace Panes' },
		{ id: 'works',       label: 'Works' },
		{ id: 'document-editor', label: 'Document Editor' },
		{ id: 'plans',       label: 'Working with Plans' },
		{ id: 'diff',        label: 'Diff Panel' },
		{ id: 'review',      label: 'Review Companion' },
		{ id: 'pull-request-merge', label: 'Merging Pull Requests' },
		{ id: 'design-mode', label: 'Design Mode' },
		{ id: 'voice',       label: 'Voice Input' },
		{ id: 'automations', label: 'Automations' },
		{ id: 'tasks',       label: 'Tasks' },
		{ id: 'files',       label: 'Opening Changed Files' },
		{ id: 'rate-limits', label: 'Rate Limit Queueing' },
		{ id: 'connections', label: 'Connections & Web UI' },
		{ id: 'settings',    label: 'Settings' },
	];

	let activeSection = $state('overview');
	let mobileTocOpen = $state(false);

	const kbdHtml = (text: string) =>
		`<kbd class="inline-flex items-center px-[5px] py-[2px] rounded-[5px] text-[11.5px] font-mono font-medium text-[#1A1714] border border-[rgba(0,0,0,0.14)] bg-[rgba(0,0,0,0.05)] leading-none shadow-[0_1px_0_rgba(0,0,0,0.08)]">${text}</kbd>`;

	onMount(() => {
		const revealObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						entry.target.classList.add('visible');
						revealObserver.unobserve(entry.target);
					}
				}
			},
			{ threshold: 0.06 },
		);
		document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

		const sectionObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) activeSection = entry.target.id;
				}
			},
			{ rootMargin: '-5% 0px -55% 0px', threshold: 0 },
		);
		for (const { id } of sections) {
			const el = document.getElementById(id);
			if (el) sectionObserver.observe(el);
		}

		const onScroll = () => {
			const scrollBottom = window.scrollY + window.innerHeight;
			const pageHeight = document.documentElement.scrollHeight;
			if (pageHeight - scrollBottom < 80) {
				activeSection = sections[sections.length - 1].id;
			}
		};
		window.addEventListener('scroll', onScroll, { passive: true });

		return () => {
			revealObserver.disconnect();
			sectionObserver.disconnect();
			window.removeEventListener('scroll', onScroll);
		};
	});
</script>

<svelte:head>
	<title>Documentation — Solus</title>
	<meta name="description" content="Solus documentation. Learn about keybindings, workspace panes, plans, diff review, Review Companion, automations, tasks, voice input, remote connections, settings, and more." />
</svelte:head>

{#snippet kbd(text: string)}
	<kbd class="inline-flex items-center px-[5px] py-[2px] rounded-[5px] text-[11.5px] font-mono font-medium text-[#1A1714] border border-[rgba(0,0,0,0.14)] bg-[rgba(0,0,0,0.05)] leading-none shadow-[0_1px_0_rgba(0,0,0,0.08)]">{text}</kbd>
{/snippet}

{#snippet kbTable(rows: [string, string][])}
	<div class="mt-4 -mx-6 max-lg:-mx-5 overflow-x-auto">
		<div class="inline-block min-w-full align-middle px-6 max-lg:px-5">
			<div class="rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
				<table class="w-full text-base/7 sm:text-[13px] border-collapse">
					<thead>
						<tr class="bg-[rgba(0,0,0,0.02)] border-b border-[rgba(0,0,0,0.07)]">
							<th class="text-left px-4 py-2.5 font-semibold text-[#1A1714] w-[200px] max-sm:w-[160px] whitespace-nowrap">Shortcut</th>
							<th class="text-left px-4 py-2.5 font-semibold text-[#1A1714] whitespace-nowrap">Action</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as [shortcut, action], i}
							<tr class={i < rows.length - 1 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}>
								<td class="px-4 py-2.5">
									<kbd class="inline-flex items-center px-[5px] py-[2px] rounded-[5px] text-[11px] font-mono font-medium text-[#1A1714] border border-[rgba(0,0,0,0.14)] bg-[rgba(0,0,0,0.05)] leading-none shadow-[0_1px_0_rgba(0,0,0,0.08)] whitespace-nowrap">{shortcut}</kbd>
								</td>
								<td class="px-4 py-2.5 text-[#6B6158]">{action}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</div>
{/snippet}

<div class="max-w-[1120px] mx-auto px-6 max-lg:px-5 pt-28 pb-24 flex gap-16 max-lg:gap-0 max-lg:flex-col">

	<!-- Mobile TOC — visible below lg -->
	<div class="lg:hidden mb-6">
		<button
			class="relative w-full flex items-center justify-between px-4 py-3 rounded-xl
			       border border-[rgba(0,0,0,0.08)] bg-white/60 backdrop-blur-sm
			       text-[14px] font-medium text-[#1A1714] transition-colors"
			onclick={() => mobileTocOpen = !mobileTocOpen}
			aria-expanded={mobileTocOpen}
		>
			<span class="flex items-center gap-2">
				<span class="w-1.5 h-1.5 rounded-full bg-[#D4AF6A] shrink-0"></span>
				{sections.find(s => s.id === activeSection)?.label ?? 'Overview'}
			</span>
			<svg
				width="16" height="16" viewBox="0 0 24 24" fill="none"
				stroke="currentColor" stroke-width="2" stroke-linecap="round"
				class="transition-transform duration-200 text-[#A09488]"
				class:rotate-180={mobileTocOpen}
			><polyline points="6 9 12 15 18 9" /></svg>
			<span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
		</button>
		{#if mobileTocOpen}
			<nav
				class="mt-2 flex flex-col gap-0.5 p-2 rounded-xl
				       border border-[rgba(0,0,0,0.08)] bg-white/95 backdrop-blur-2xl
				       shadow-[0_8px_32px_rgba(0,0,0,0.10)]"
				style="animation: popup-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)"
			>
				{#each sections as section}
					<a
						href="#{section.id}"
						class="flex items-center gap-2 px-3 py-2.5 rounded-lg text-[14px] no-underline transition-colors"
						class:text-[#1A1714]={activeSection === section.id}
						class:font-medium={activeSection === section.id}
						class:bg-[rgba(212,175,106,0.1)]={activeSection === section.id}
						class:text-[#6B6158]={activeSection !== section.id}
						onclick={() => mobileTocOpen = false}
					>
						<span
							class="w-1 h-1 rounded-full shrink-0 transition-colors"
							class:bg-[#D4AF6A]={activeSection === section.id}
							class:bg-transparent={activeSection !== section.id}
						></span>
						{section.label}
					</a>
				{/each}
				<div class="h-px bg-black/[0.06] mx-2 my-1"></div>
				<a href="/" class="px-3 py-2 text-[13px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors rounded-lg">← Back to home</a>
				<a href="/privacy" class="px-3 py-2 text-[13px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors rounded-lg">Privacy</a>
				<a href="/terms" class="px-3 py-2 text-[13px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors rounded-lg">Terms</a>
			</nav>
		{/if}
	</div>

	<aside class="w-[188px] shrink-0 max-lg:hidden sticky top-28 self-start">
			<a href="/" class="flex items-center gap-2 no-underline mb-7">
				<svg width="17" height="17" viewBox="-60 -60 120 120" fill="none" aria-hidden="true">
					<circle cx="0" cy="0" r="31.2" fill="#D4AF6A" />
					<g stroke="#D4AF6A" stroke-width="10.4" stroke-linecap="round">
						<path d="M 0,-52 A 52,52 0 0 1 52,0" />
						<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
						<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
					</g>
				</svg>
				<span class="font-[family-name:var(--font-display)] text-[14px] font-bold tracking-[-0.03em] text-[#1A1714]">Solus</span>
				<span class="text-[11px] font-medium text-[#A09488] ml-0.5">docs</span>
			</a>

			<p class="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-[#C4B8AE] mb-2.5 px-2">Reference</p>
			<nav class="flex flex-col">
				{#each sections as section}
					<a
						href="#{section.id}"
						class="group flex items-center gap-2 px-2 py-[5px] rounded-lg text-[13px] no-underline transition-all duration-150"
						class:text-[#1A1714]={activeSection === section.id}
						class:font-medium={activeSection === section.id}
						class:bg-[rgba(212,175,106,0.1)]={activeSection === section.id}
						class:text-[#6B6158]={activeSection !== section.id}
						class:hover:text-[#1A1714]={activeSection !== section.id}
						class:hover:bg-[rgba(0,0,0,0.03)]={activeSection !== section.id}
					>
						<span
							class="w-1 h-1 rounded-full shrink-0 transition-all duration-150"
							class:bg-[#D4AF6A]={activeSection === section.id}
							class:bg-transparent={activeSection !== section.id}
						></span>
						{section.label}
					</a>
				{/each}
			</nav>

			<div class="mt-8 pt-6 border-t border-[rgba(0,0,0,0.06)] flex flex-col gap-1">
				<a href="/" class="text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors px-2 py-1">← Back to home</a>
				<a href="/privacy" class="text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors px-2 py-1">Privacy</a>
				<a href="/terms" class="text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors px-2 py-1">Terms</a>
			</div>
	</aside>

	<main class="flex-1 min-w-0">

		<div class="reveal mb-12 pb-10 border-b border-[rgba(0,0,0,0.07)]">
			<div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[rgba(212,175,106,0.3)] bg-[rgba(212,175,106,0.06)] mb-4">
				<span class="text-[10.5px] font-semibold tracking-[0.07em] uppercase text-[#C4973A]">Documentation</span>
			</div>
			<h1 class="text-[32px] max-[1440px]:text-[30px] font-semibold tracking-[-0.03em] leading-[1.15] mb-2.5 text-[#1A1714]">
				Solus Reference
			</h1>
			<p class="text-base sm:text-[15px] max-[1440px]:sm:text-[14px] text-[#6B6158] leading-relaxed max-w-[560px]">
				Everything you need to know — keybindings, workspace panes, plans, diff review, Review Companion, automations, tasks, voice input, connections, and settings.
			</p>
			<p class="text-[12px] text-[#B0A499] mt-3">Updated July 15, 2026</p>
		</div>

		<div class="flex flex-col text-base/7 sm:text-[15px] sm:leading-[1.8] max-[1440px]:sm:text-[14px] text-[#6B6158]">

			<section id="overview" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)] first:pt-0">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Overview</h2>
				<p>
					Solus is a native macOS floating overlay for AI coding assistants. It lives at the bottom of your
					screen and is accessible from any app via a global shortcut — no terminal switching, no
					context loss.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Multi-tab sessions', 'Run independent agent sessions side by side, each with its own working directory and permission mode.'],
						['Workspace panes', 'Open plans, Works, automations, reviews, changed files, and diffs as focused panes or beside the active conversation. Closing a pane returns to the same chat with scroll position and drafts preserved.'],
						['Plan mode', "Review your agent's plan before it executes. Annotate with inline comments, then approve or reject. Pin or save plans for later reference and browse revision history when the plan changes."],
						['Diff panel', 'Review every file your agent touched in a side panel. Navigate between files, leave line-level comments, and send annotated feedback back in one click.'],
						['Review companion', "A second agent reviews your branch's changes and writes an inline report — grouped findings you can click to jump straight to the relevant hunk in the diff."],
						['Pull request merging', 'Merge an individual pull request with a merge commit, squash, or rebase. Conflicted PRs can be handed to an agent in an isolated worktree.'],
						['Works', 'Generated documents and slides are saved as Works. Open the gallery to search, edit, copy, or delete them later.'],
						['Design Mode', 'Take a screenshot, draw rectangles, arrows, pins, and text annotations on it, then send the annotated image directly to your agent — no screenshots app needed.'],
						['Voice input', 'Dictate prompts hands-free with local Whisper transcription — audio never leaves your machine.'],
						['Automations', 'Save a prompt and run it on a schedule — daily, weekly, on an interval, or a raw cron expression — or trigger it on demand. Agents can create automations for you too.'],
						['Tasks', 'Track project work from local tasks or GitHub Issues. Start a session from a task so the agent receives the ticket context and Solus can link the work back to that task.'],
						['File & screenshot attachments', 'Attach files or screenshots directly in the input bar.'],
						['Session history', 'Resume past sessions or pick up where you left off.'],
						['Remote connections', 'Connect to your Solus desktop instance from any browser on your network — pair once and work from your phone, tablet, or another computer.'],
						['Rate limit queueing', 'Automatically wait out rate limits and re-send without losing your prompt.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {desc}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section id="keybindings" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Keybindings</h2>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-0">Global</h3>
				<p class="text-base/7 sm:text-[14px]">These work system-wide, even when Solus is hidden.</p>
				{@render kbTable([
					['⌥Space', 'Toggle window'],
					['⌘⇧K', 'Toggle window (alternative)'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">General</h3>
				{@render kbTable([
					['⌘O', 'Select project'],
					['⌥⇧,', 'Open settings'],
					['⌥L', 'Focus input'],
					['⌥⇧Q', 'Toggle quick actions'],
					['⌥⇧`', 'Open terminal'],
					['⌥⇧C', 'Commit and push'],
					['⌥⇧.', 'Sync (pull)'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Tabs</h3>
				{@render kbTable([
					['⌘T', 'New tab'],
					['⌥F', 'Fork session'],
					['⌥⇧W', 'Close current tab'],
					['⌥⇧N', 'Next tab'],
					['⌥⇧P', 'Previous tab'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">View</h3>
				{@render kbTable([
					['⌥⇧E', 'Toggle editor / pill mode'],
					['⌥⇧D', 'Toggle diff panel (editor mode)'],
					['⌥M', 'Toggle project panel (editor mode)'],
					['⌥⇧L', 'Open plans gallery'],
					['⌥⇧;', 'Open Works gallery'],
					['⌥B', 'Toggle sidebar'],
					['⌥⇧U', 'Cycle sidebar view'],
					['⌥⇧=', 'Expand / collapse input'],
					['⌥H', 'Scroll to top'],
					['⌥⇧\\', 'Move supported pane between focus and split'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Compose</h3>
				{@render kbTable([
					['⌥⇧A', 'Attach file'],
					['⌥⇧S', 'Take screenshot'],
					['⌥⇧I', 'Design annotation mode'],
					['⌥⇧O', 'Open files pane'],
					['⌥⇧F', 'Open changed files'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Agent</h3>
				{@render kbTable([
					['⌥⇧Tab', 'Cycle permission mode (Ask → Auto → Plan)'],
					['⌥⇧M', 'Cycle AI model'],
					['⌥⇧G', 'Cycle agent'],
					['⌥⇧Z', 'Open model / reasoning menu'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Navigation</h3>
				{@render kbTable([
					['⌥⇧R / ⌥⇧J', 'Toggle session history picker'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Voice</h3>
				{@render kbTable([
					['⌥⇧K', 'Toggle mic recording'],
				])}
				<p class="text-base/7 sm:text-[14px] mt-2 text-[#A09488]">Voice Mode (continuous, hands-free) is enabled in <strong class="text-[#A09488] font-medium">Settings → Input</strong>.</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Automations</h3>
				<p class="text-base/7 sm:text-[14px]">Open the Automations page with {@render kbd('⌥⇧V')}. These shortcuts are active while it's open.</p>
				{@render kbTable([
					['⌥⇧V', 'Open / close automations'],
					['⌥N', 'New automation'],
					['Esc', 'Back to list / close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Tasks</h3>
				<p class="text-base/7 sm:text-[14px]">Open the Tasks page with {@render kbd('⌥⇧T')}. These shortcuts are active while it's open.</p>
				{@render kbTable([
					['⌥⇧T', 'Open / close tasks'],
					['↑ / ↓', 'Move between task cards'],
					['Esc', 'Back to list / clear selection / close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Git</h3>
				{@render kbTable([
					['⌥⇧B', 'Toggle worktree mode'],
					['⌥⇧H', 'Switch worktree'],
					['⌥⇧Y', 'Open worktree in terminal'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Pull requests</h3>
					<p class="text-base/7 sm:text-[14px]">These shortcuts are active while the Pull Requests page is open.</p>
					{@render kbTable([
						['Esc', 'Close'],
					])}

					<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Input & menus</h3>
				{@render kbTable([
					['Enter', 'Send message'],
					['⇧Enter', 'New line'],
					['↑ / ↓', 'Navigate prompt history (cursor at start of input)'],
					['@ or ~/ ./ ../', 'Open file autocomplete'],
					['↑ / ↓  (file menu)', 'Navigate files'],
					['Tab or Enter  (file menu)', 'Select file'],
					['Escape  (file menu)', 'Close file menu'],
					['/', 'Open slash command menu'],
					['↑ / ↓  (slash menu)', 'Navigate commands'],
					['Tab  (slash menu)', 'Select command'],
					['Escape  (slash menu)', 'Close slash menu'],
					['⌘Enter / Ctrl+Enter  (plan)', 'Save inline comment'],
					['Escape  (plan comment)', 'Cancel comment'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Plan modal</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while a plan is open.</p>
				{@render kbTable([
					['⌥S', 'Save / done editing'],
					['⌥C', 'Copy plan to clipboard'],
					['⌥B', 'Save for later (bookmark)'],
					['⌥M', 'Toggle comments'],
					['⌘M', 'Comment on selection'],
					['⌥O', 'Open session (preview mode)'],
					['⌥Y', 'Approve (ask mode)'],
					['⌥A', 'Approve (auto mode)'],
					['⌥R', 'Reject'],
					['⌥V', 'Reject with feedback'],
					['⌥L', 'Focus comment field'],
					['Esc', 'Close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Plans gallery</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while the plans gallery is open ({@render kbd('⌥⇧L')}).</p>
				{@render kbTable([
					['⌥⇧L', 'Open / close gallery'],
					['/ (slash)', 'Focus search'],
					['↑ / ↓ / ← / →', 'Navigate plans'],
					['Enter', 'Open plan'],
					['⇧Enter', 'Resume session from plan'],
					['⌥B', 'Toggle bookmark'],
					['Esc', 'Close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Diff panel</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while the diff panel is open.</p>
				{@render kbTable([
					['⌥⇧D', 'Toggle diff panel'],
					['⌥M', 'Maximize / restore panel'],
					['⌥⇧→', 'Next turn'],
					['⌥⇧←', 'Previous turn'],
					['⌥⇧F', 'Next file'],
					['⌥⇧B', 'Previous file'],
					['⌥F', 'Search files'],
					['⌥⇧P', 'Toggle full paths'],
					['⌥T', 'Toggle file tree'],
					['⌥⇧V', 'Toggle split / unified view'],
					['⌥⇧C', 'Start comment on current line'],
					['⌥⇧]', 'Next comment'],
					['⌥⇧[', 'Previous comment'],
					['⌥⇧/', 'Toggle shortcuts legend'],
					['⌥⇧↵', 'Send diff feedback to session'],
					['⌘↵ / Ctrl↵', 'Send feedback from feedback box'],
					['⌘⇧↵ / Ctrl⇧↵', 'Send feedback to a new session from feedback box'],
					['Esc', 'Close panel / clear selection'],
				])}
			</section>

			<section id="panes" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Workspace Panes</h2>
				<p>
					In editor mode, Solus keeps the active conversation mounted while other surfaces open as panes.
					That means plans, Works, automations, reviews, changed files, and diffs can cover the chat for
					focused reading or sit beside it for side-by-side work.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How panes behave</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Focus or split', `Use the pane header action or ${kbdHtml('⌥⇧\\')} to move supported plans, Works, automations, and reviews between the focused primary pane and the split side pane.`],
						['Diffs and files', `Open the diff with ${kbdHtml('⌥⇧D')}, the files pane with ${kbdHtml('⌥⇧O')}, or changed files with ${kbdHtml('⌥⇧F')}; they appear beside the active conversation so you can inspect code and keep prompting.`],
						['PR review', 'Opening a pull request starts with the review surface maximized. Use the Chat control to reveal the worktree-rooted conversation beside Activity, Guide, and Diff.'],
						['State stays put', 'Closing a pane restores the conversation underneath without resetting scroll position, mounted tabs, or prompt drafts.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section id="works" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Works</h2>
				<p>
					Works are long-form artifacts created by your agents, including documents and slide drafts. When
					an assistant returns a fenced document artifact, Solus extracts it from the chat, saves it to disk,
					and shows it as an editable Work instead of leaving a long Markdown block in the conversation.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open the gallery', `Press ${kbdHtml('⌥⇧;')} or click <strong class="text-[#1A1714] font-medium">Folio</strong> in the sidebar to search every saved Work.`],
						['Edit in place', 'Open a Work to make changes in the Document Editor. Saving updates the stored Work and preserves the conversation reference.'],
						['Copy or reuse', `Use ${kbdHtml('⌥C')} while a Work is open to copy its Markdown content back to the clipboard.`],
						['Storage', 'Works are stored locally under your Solus data directory, with a manifest plus one content file per Work.'],
						['Supported types', 'Documents are fully editable today. Slide artifacts are tracked as Works so they can be surfaced and expanded by the app.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Works gallery</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while the Works gallery is open ({@render kbd('⌥⇧;')}).</p>
				{@render kbTable([
					['⌥⇧;', 'Open / close gallery'],
					['/ (slash)', 'Focus search'],
					['↑ / ↓', 'Navigate Works'],
					['Enter', 'Open selected Work'],
					['⌥Backspace', 'Delete selected Work'],
					['Esc', 'Close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Work modal</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while a Work is open.</p>
				{@render kbTable([
					['⌥S', 'Save'],
					['⌥C', 'Copy to clipboard'],
					['Esc', 'Close'],
				])}
			</section>

			<section id="document-editor" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Document Editor</h2>
				<p>
					The Document Editor is a rich-text Markdown editor for writing structured prompts, plans, and notes.
					It renders Markdown natively and syncs bidirectionally with raw Markdown — toggle between views
					using the <strong class="text-[#1A1714] font-medium">Markdown</strong> button in the top-right corner of the editor.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Formatting toolbar</h3>
				<p class="text-base/7 sm:text-[14px]">Select any text to reveal an inline bubble menu with the following actions:</p>
				<div class="mt-3 flex flex-wrap gap-2">
					{#each ['Bold', 'Italic', 'Strikethrough', 'Inline code', 'Link', 'H1', 'H2', 'H3', 'Bullet list', 'Numbered list', 'Blockquote'] as label}
						<span class="inline-flex items-center px-2.5 py-1 rounded-lg text-[12px] font-medium text-[#6B6158] border border-[rgba(0,0,0,0.08)] bg-[rgba(0,0,0,0.02)]">{label}</span>
					{/each}
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Slash commands</h3>
				<p class="text-base/7 sm:text-[14px]">Type <kbd class="inline-flex items-center px-[5px] py-[2px] rounded-[5px] text-[11.5px] font-mono font-medium text-[#1A1714] border border-[rgba(0,0,0,0.14)] bg-[rgba(0,0,0,0.05)] leading-none shadow-[0_1px_0_rgba(0,0,0,0.08)]">/</kbd> at the start of a line to open the block-type menu. Continue typing to filter.</p>
				{@render kbTable([
					['/text', 'Plain paragraph'],
					['/h1 · /h2 · /h3', 'Heading levels'],
					['/bullet', 'Bullet list'],
					['/numbered', 'Numbered list'],
					['/task', 'Task / checklist list'],
					['/quote', 'Blockquote'],
					['/code', 'Syntax-highlighted code block'],
					['/table', 'Insert a 3×3 table'],
					['/divider', 'Horizontal rule'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Editor shortcuts</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active when focus is inside the Document Editor.</p>
				{@render kbTable([
					['⌥⇧S', 'Toggle strikethrough'],
					['⌥⇧K', 'Insert / remove hyperlink'],
				])}
			</section>

			<section id="plans" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Working with Plans</h2>
				<p>
					Plan mode is a permission workflow where your agent drafts a full plan before taking any action.
					Use it when you want to review and guide its approach before it touches your code.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						[null, `Enable by selecting <strong class="text-[#1A1714] font-medium">Plan</strong> as the permission mode on a tab, or press <kbd class="inline-flex items-center px-[5px] py-[2px] rounded-[5px] text-[11px] font-mono font-medium text-[#1A1714] border border-[rgba(0,0,0,0.14)] bg-[rgba(0,0,0,0.05)] leading-none shadow-[0_1px_0_rgba(0,0,0,0.08)]">⌥⇧Tab</kbd> to cycle through modes.`],
						[null, 'When your agent is ready, it opens a full-screen plan view rendered as Markdown.'],
						['Inline comments', 'Select any text in the plan to attach a comment to that specific section. Comments are included when you approve.'],
						['General feedback', 'Add a top-level comment that applies to the whole plan.'],
						['Approve', 'Choose whether your agent should continue in Ask or Auto mode, then confirm. It proceeds with your feedback incorporated.'],
						['Reject', 'The agent stops — redirect it with a new prompt.'],
						['Pin', 'Pin a plan to keep it at the top of the plans gallery for quick reference.'],
						['Save for later', 'Bookmark a plan without pinning it — useful for plans you want to revisit.'],
						['Revisions', 'When your agent updates a plan, previous versions are preserved. Use the revision dropdown in the plan view to compare or revert.'],
					['Any model', 'Plans work with every model, not just those that natively support plan mode. Solus handles the orchestration so you can review and approve plans regardless of which AI model powers the session.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span>{#if title}<strong class="text-[#1A1714] font-medium">{title}.</strong>{/if} {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">Plans are written to disk as Markdown files so you can reference them later. Open the plans gallery with {@render kbd('⌥⇧L')} to search and browse all plans across sessions.</p>
			</section>

			<section id="diff" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Diff Panel</h2>
				<p>
					The diff panel shows every file your agent has touched in the current session. Open it with
					{@render kbd('⌥⇧D')} (editor mode) to review changes file by file, leave line-level comments,
					and send consolidated feedback back without switching context.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How it works</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open the panel', `Press ${kbdHtml('⌥⇧D')} in editor mode, or click the diff button in the editor toolbar.`],
						['Navigate files', `Use ${kbdHtml('⌥⇧F')} and ${kbdHtml('⌥⇧B')} to step through each changed file, search files with ${kbdHtml('⌥F')}, or click a file in the file list.`],
						['Filter by turn', `Select a specific turn in the conversation, or press ${kbdHtml('⌥⇧→')} and ${kbdHtml('⌥⇧←')} to move through turns.`],
						['Leave comments', `Press ${kbdHtml('⌥⇧C')} to start an inline comment on the current line. Comments are attached to the specific file and line range.`],
						['Send feedback', `Add a general comment in the feedback box and press ${kbdHtml('⌥⇧↵')} from anywhere in the panel, or ${kbdHtml('⌘↵')} while focused in the feedback box.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">See the <a href="#keybindings" class="text-[#C4973A] no-underline hover:underline">Keybindings → Diff panel</a> section for the full list of shortcuts.</p>
			</section>

			<section id="review" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Review Companion</h2>
				<p>
					The Review Companion turns a second agent loose on your branch. It reviews everything that changed —
					commits on the branch, uncommitted edits, and untracked files — and writes an inline report of grouped
					findings. Each finding links directly to the relevant hunk, so a click jumps you to that file and line
					in the diff. It's a fast second opinion before you commit or open a PR.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How to use it</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open the project panel', `In editor mode, open the project panel with ${kbdHtml('⌥M')} and find the <strong class="text-[#1A1714] font-medium">Git</strong> section.`],
						['Generate a review', `Click <strong class="text-[#1A1714] font-medium">Review changes</strong>. The review agent analyzes the branch diff and builds the report — this runs in the background while you keep working.`],
						['Open the report', `Once it's ready the button becomes <strong class="text-[#1A1714] font-medium">View report</strong>. Click it to open the companion in the main pane.`],
						['Jump to a finding', 'Click any finding in the report to focus that exact file and line in the diff / preview pane alongside it.'],
						['Regenerate', 'After more changes, use the refresh button in the companion header (or Review changes again) to produce an up-to-date report.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<p class="mt-5 text-[14px] text-[#A09488]">
					Choose which agent and model write the review under
					<strong class="text-[#A09488] font-medium">Settings → Review companion</strong>. By default it follows
					your active agent and that agent's default model.
				</p>
			</section>

			<section id="pull-request-merge" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Merging Pull Requests</h2>
				<p>
					Solus can merge an individual pull request directly from its review surface. Choose a merge commit,
					squash, or rebase, then confirm the result without leaving the review.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How to use it</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open Pull Requests', 'From the sidebar, open the Pull Requests page for the current project and select the PR you want to review.'],
						['Check readiness', 'The review surface shows the PR status, required checks, reviewers, and unresolved conversations.'],
						['Choose a method', 'Use the merge action to pick <strong class="text-[#1A1714] font-medium">Merge commit</strong>, <strong class="text-[#1A1714] font-medium">Squash</strong>, or <strong class="text-[#1A1714] font-medium">Rebase</strong>.'],
						['Merge', 'Confirm the action. Solus calls the code host directly and reports any branch-protection or readiness refusal in place.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Resolving conflicts</h3>
				<p class="text-base/7 sm:text-[14px]">
					When a PR conflicts with its base branch, choose <strong class="text-[#1A1714] font-medium">Resolve conflicts</strong>.
					Solus checks the PR out into an isolated worktree, starts the merge, and opens an agent session with
					the conflicted files. The agent resolves, tests, commits, and pushes the branch; you can then return
					to the PR and merge it normally.
				</p>
			</section>

			<section id="design-mode" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Design Mode</h2>
				<p>
					Design Mode lets you take a screenshot of any window, annotate it with drawing tools, and send
					the annotated image directly to your agent — all without leaving Solus. It's the fastest way to
					describe a UI bug, highlight a layout issue, or point your agent at exactly what needs changing.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How to use it</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Trigger a screenshot', `Press ${kbdHtml('⌥⇧S')} or click the camera icon in the input bar. Solus captures the active window and opens the annotation overlay full-screen.`],
						['Annotate', 'Use the left-side toolbar to draw on the screenshot. Confirm when done — the annotated image is added as an attachment in the input bar.'],
						['Send to agent', 'Add any additional context in the input bar and press Enter. Your agent receives both the annotated screenshot and your message.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Annotation tools</h3>
				{@render kbTable([
					['1 · Rectangle', 'Draw a box to highlight a region. Drag from corner to corner.'],
					['2 · Arrow', 'Draw a directed arrow pointing at a specific element.'],
					['3 · Marker', 'Drop a numbered pin. Each pin auto-increments so you can refer to them by number in your message.'],
					['4 · Text', 'Click anywhere to place a text label directly on the screenshot.'],
					['5 · Eraser', 'Click the annotation nearest your cursor to remove it.'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Keyboard shortcuts (annotation overlay)</h3>
				{@render kbTable([
					['1 – 5', 'Switch tool'],
					['U', 'Undo last annotation'],
					['R', 'Redo'],
					['⌘Z / Ctrl Z', 'Undo'],
					['⌘⇧Z / Ctrl Y', 'Redo'],
					['⌘↩ / Enter', 'Confirm and attach annotated image'],
					['Escape', 'Cancel and discard'],
				])}

				<p class="mt-5 text-[14px] text-[#A09488]">The annotated image is composited at full screenshot resolution before being sent — annotations are baked into the image your agent receives.</p>
			</section>

			<section id="voice" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Voice Input: Mic vs Voice Mode</h2>
				<p>
					Solus has two voice input modes. Both transcribe locally using Whisper — audio never leaves
					your machine.
				</p>

				<div class="mt-6 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Mic · manual</p>
						<p class="text-base/7 sm:text-[14px]">Press {@render kbd('⌥⇧K')} or click the mic icon to start. Press again to stop — or just pause for 2 seconds and recording ends automatically. Transcript is inserted for review before sending.</p>
					</div>
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Voice Mode · continuous</p>
						<p class="text-base/7 sm:text-[14px]">Enable in Settings → Input. Window open → record → silence → send → agent replies → record again. Hands-free loop. Hidden window cancels recording.</p>
					</div>
				</div>
			</section>

			<section id="automations" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Automations</h2>
				<p>
					An automation is a saved prompt that runs on a schedule or on demand. Use it for recurring work —
					a daily TODO sweep, a nightly dependency check, a weekly changelog draft — and let the agent do it
					unattended. Open the Automations page with {@render kbd('⌥⇧V')} or the
					<strong class="text-[#1A1714] font-medium">Automations</strong> entry in the sidebar; press
					{@render kbd('⌥N')} to create one.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">What each automation captures</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Prompt', 'The instruction submitted to the agent on every run.'],
						['Agent & model', 'Which CLI agent runs it (Claude or Codex), the model, and the reasoning effort. Each run executes headless in Auto permission mode.'],
						['Working directory', 'The project directory the run executes in — defaults to your active project.'],
						['Max turns', 'An optional cap on how many turns a single run may take, as a guardrail.'],
						['Enabled / paused', 'Toggle an automation on or off without deleting it. Paused automations never fire on schedule.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Triggers</h3>
				{@render kbTable([
					['Manual', 'No schedule — runs only when you click Run now or an agent triggers it.'],
					['Once', 'Run a single time at a specific date and time.'],
					['Interval', 'Run every N minutes, hours, or days.'],
					['Daily', 'Run every day at a set time.'],
					['Weekly', 'Run on a chosen weekday at a set time.'],
					['Monthly', 'Run on a chosen day of the month at a set time.'],
					['Cron', 'A raw 5-field cron expression (minute hour day-of-month month day-of-week) with an IANA timezone.'],
				])}
				<p class="mt-3 text-[14px] text-[#A09488]">Scheduled triggers fire only while Solus is open — they don't run in the background when the app is quit.</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Running & history</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Run now', 'Trigger any enabled automation immediately to test it, regardless of its schedule.'],
						['Run history', 'Each automation keeps a log of past runs with status (running, succeeded, failed), tool-call count, and output or error.'],
						['Open a run', 'Open a completed run as a full session to inspect exactly what the agent did.'],
						['Created by agents', 'Agents can create, edit, and trigger automations for you with their built-in automation tools. Agent-created automations are tagged in the list.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {desc}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section id="tasks" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Tasks</h2>
				<p>
					Tasks are project-scoped tickets you can browse, create, and start agent sessions from without
					leaving Solus. Open the Tasks page with {@render kbd('⌥⇧T')}, from the command palette, or from
					the task glance on the home screen.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Providers</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Local', 'The built-in local task list stores tasks per project on your Mac. It supports tasks, epics, sub-tasks, priority, due dates, comments, PR links, and deletes with undo.'],
						['GitHub Issues', 'Projects can read and update GitHub Issues from their repository remote. Create issues, change status, post comments, and open the source ticket from Solus.'],
						['Project settings', 'Choose the provider per project in Settings. If a GitHub-backed project needs authentication, the Tasks page offers a direct connection prompt.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Working from a task</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['List or board', 'Use the dense list for grouped tasks and local epics, or switch to the board view to move tasks between Open, In progress, and Done.'],
						['Search and sort', 'Filter by status, search across task text, scope to work assigned to you, and sort by recent updates, priority, or due date.'],
						['Start a session', 'Start from any task to open a new tab in that project with the task attached. The first message includes the hydrated ticket context for the agent.'],
						['Resume work', 'When a session is linked to a task, the task card shows a back-link so you can jump back into the most recent session for that task.'],
						['Capture outcomes', 'Task details can track the branch and PR that came out of the work, so the ticket stays connected to the implementation.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {desc}</span>
						</li>
					{/each}
				</ul>

				<p class="mt-5 text-[14px] text-[#A09488]">See the <a href="#keybindings" class="text-[#C4973A] no-underline hover:underline">Keybindings → Tasks</a> section for task navigation shortcuts.</p>
			</section>

			<section id="files" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Opening Changed Files</h2>
				<p>
					Whenever your agent edits or writes a file, a diff preview appears inline in the conversation.
					If you have a default editor configured in Settings, an <strong class="text-[#1A1714] font-medium">Open</strong> button
					appears on each tool result — click it to jump directly to that file in your editor.
				</p>
				<p class="mt-3">
					To open every file changed in the current session at once, press {@render kbd('⌥⇧F')}.
				</p>
				<p class="mt-5 text-[14px]">
					Supported editors (auto-detected at launch):
					<span class="font-medium text-[#1A1714]">VS Code</span>,
					<span class="font-medium text-[#1A1714]">vim</span>,
					<span class="font-medium text-[#1A1714]">nvim</span>,
					<span class="font-medium text-[#1A1714]">helix</span>.
					Set your preferred editor in Settings.
				</p>
			</section>

			<section id="rate-limits" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Rate Limit Queueing</h2>
				<p>
					When your AI coding assistant hits an API rate limit, Solus handles it so you don't lose your work.
					Four behaviors are available, configurable globally in Settings or per-tab at any time:
				</p>
				<div class="mt-5 flex flex-col gap-3">
					<div class="flex gap-3">
						<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
						<span><strong class="text-[#1A1714] font-medium">Ask (default).</strong> A card appears prompting you to choose how to handle the limit.</span>
					</div>
					<div class="flex gap-3">
						<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
						<span><strong class="text-[#1A1714] font-medium">Queue.</strong> Silently waits for the rate limit to reset, then re-sends your message automatically.</span>
					</div>
					<div class="flex gap-3">
						<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
						<span><strong class="text-[#1A1714] font-medium">Continue.</strong> Lets your agent proceed with what it has so far, without waiting for the limit to reset.</span>
					</div>
					<div class="flex gap-3">
						<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
						<span><strong class="text-[#1A1714] font-medium">Stop.</strong> Discards the queued message and halts the current task.</span>
					</div>
				</div>
				<p class="mt-5 text-[14px] text-[#A09488]">The global default is set in Settings under <em>Rate limit behavior</em>. Individual tabs can override this independently.</p>
			</section>

			<section id="connections" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Connections & Web UI</h2>
				<p>
					The Solus desktop app doubles as a local server that serves a full web interface. Any browser on
					your network — phone, tablet, or another computer — can connect and interact with your desktop
					agent in real time. A one-time pairing step issues a session token; after that, subsequent visits
					reconnect automatically. You can also run Solus headless as a
					<a href="#connections" class="text-[#C4973A] no-underline hover:underline">self-hosted server</a>
					on macOS or Linux with no desktop app at all.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How it works</h3>
				<p class="text-base/7 sm:text-[14px]">
					When Solus is running it listens on port <strong class="text-[#1A1714] font-medium">3000</strong> by default (override with the
					<code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">SOLUS_PORT</code> env var).
					The web UI is served at that address — navigate to it from any device on your network and you'll
					see the pairing screen on the first visit.
				</p>
				<div class="mt-4 p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)] font-mono text-[13px] text-[#6B6158]">
					http://&lt;your-mac-ip&gt;:3000 &nbsp;·&nbsp; e.g. http://192.168.1.42:3000
				</div>
				<p class="mt-3 text-[14px] text-[#A09488]">
					The exact addresses Solus is reachable from are listed in
					<strong class="text-[#A09488] font-medium">Settings → Connections</strong> — including localhost,
					LAN, and any Tailscale / VPN addresses.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Step 1 — Generate a pair code (desktop)</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open Connections', `Go to <strong class="text-[#1A1714] font-medium">Settings → Connections</strong> in the Solus desktop app.`],
						['Generate a pair code', `Click <strong class="text-[#1A1714] font-medium">Generate pair code</strong>. A 6-digit code appears alongside a set of pairing links — one per network interface the server is reachable from. <strong class="text-[#1A1714] font-medium">Codes expire after 5 minutes.</strong>`],
						['Share with the device', `Copy a pairing link and send it to the device (AirDrop, Messages, etc.), or have the 6-digit code ready for manual entry.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Step 2 — Connect from the browser</h3>
				<p class="text-base/7 sm:text-[14px]">Navigate to the Solus server address in your browser. On the first visit you'll see the pairing screen. There are two ways to pair:</p>

				<div class="mt-4 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Pairing link</p>
						<p class="text-base/7 sm:text-[14px]">Paste the full pairing link copied from the desktop app. The server address and one-time token are extracted from the URL automatically — no manual typing needed.</p>
					</div>
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Manual setup</p>
						<p class="text-base/7 sm:text-[14px]">Switch to the <strong class="text-[#1A1714] font-medium">Manual setup</strong> tab, enter the server address (e.g. <code class="text-[12px] font-mono">192.168.1.42:3000</code>) and the 6-digit pair code shown in the desktop app.</p>
					</div>
				</div>

				<p class="mt-4 text-[14px]">
					Either way, you can optionally set a <strong class="text-[#1A1714] font-medium">device name</strong> — it defaults to your browser and OS
					(e.g. "Safari on macOS") and appears in the desktop app's connected-devices list so you know what's connected.
				</p>
				<p class="mt-3 text-[14px] text-[#A09488]">
					After pairing, the browser receives a long-lived session token that is stored locally. On every
					subsequent visit the web app reconnects automatically — no re-pairing needed unless you revoke
					the device from the desktop app.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Reconnection &amp; reliability</h3>
				<p class="text-base/7 sm:text-[14px]">
					The web UI maintains a WebSocket connection to the desktop server and retries automatically if it
					drops — waking from sleep, switching networks, or a momentary blip all recover without any manual
					action. A connection status indicator appears while reconnecting.
				</p>
				<p class="text-base/7 sm:text-[14px] mt-3">
					On supported browsers you can also enable <strong class="text-[#1A1714] font-medium">web push
					notifications</strong> from the connected client, so a run finishing or needing your attention
					reaches you even when the tab is in the background.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Managing devices</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Connected devices', 'The desktop Connections panel shows every paired device with its label and last-connected time.'],
						['Revoke access', 'Click the revoke button next to a device to invalidate its session token immediately. The browser is disconnected and must re-pair to reconnect.'],
						['Multiple servers', 'The web app remembers every server you\'ve paired with. On subsequent visits, choose from your saved server list or add another one. Hit the ✕ on a server to remove it.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Network &amp; security</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Local only', 'All traffic between the browser and Solus travels over your local network — nothing is routed through external servers.'],
						['Session tokens', 'Each paired device holds a unique session token. Revoking one device has no effect on any other.'],
						['Tailscale / VPN', 'Solus advertises all reachable addresses, including Tailscale IPs. Use a Tailscale pairing link to securely reach your desktop from outside your LAN.'],
						['Loopback (same machine)', `Navigating to <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">http://localhost:3000</code> in a browser on the same Mac connects without pairing in development mode. In production builds, the normal pairing flow applies even on loopback.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
			<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Self-hosted server</h3>
				<p class="text-base/7 sm:text-[14px]">
					Beyond the desktop app, Solus ships a standalone server you can run on a macOS or Linux machine —
					a home server, a VPS, or any always-on box — and reach entirely from the browser. The easiest
					install is through Homebrew:
				</p>
				<div class="mt-4 p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)] font-mono text-[13px] text-[#6B6158] whitespace-pre-wrap">brew install Ashton-Sidhu/tap/solus   # CLI + vendored server runtime
brew services start solus             # run the daemon in the background
solus claim                           # claim the server from this machine</div>
				<ul class="mt-4 flex flex-col gap-3 list-none p-0">
					{#each [
						['Manage from the CLI', `Run <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus start</code>, <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus logs</code>, and <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus update</code> to run, tail, and upgrade the daemon. Data lives under <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">~/.solus</code>.`],
						['Claim it once', `<code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus claim</code> prints a claim link, code, and QR you scan or open in a browser to take ownership of a fresh server. After that, the normal device pairing flow applies.`],
						['Stays updated', 'Homebrew installs self-update with <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">brew upgrade solus</code>; tarball installs update in place via <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus update</code>.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section id="settings" class="reveal py-10">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Settings</h2>
				<p>
					Open Settings with {@render kbd('⌥⇧,')}. All preferences are stored locally on your machine.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Display</h3>
				<div class="mt-3 rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
					{#each [
						['Editor mode', `Switch between the full-width editor layout and the compact pill overlay. The editor layout is designed for focused sessions, while pill mode stays out of the way for multitasking. Toggle with <kbd class="inline-flex items-center px-[5px] py-[2px] rounded-[5px] text-[11px] font-mono font-medium text-[#1A1714] border border-[rgba(0,0,0,0.14)] bg-[rgba(0,0,0,0.05)] leading-none shadow-[0_1px_0_rgba(0,0,0,0.08)]">⌥⇧E</kbd>.`],
						['Dark theme', 'Toggle between light and dark appearance. Applies immediately across all UI surfaces.'],
						['Font size', 'Adjust the base font size (in pixels) for messages and code blocks. Use the stepper or type a value directly. Minimum is 8px.'],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''} {i < 2 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Agent & workflow</h3>
				<div class="mt-3 rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
					{#each [
						['Default agent', 'Choose which CLI agent to use for new sessions. Solus auto-detects installed agents and disables unavailable ones.'],
						['Rate limit behavior', 'Global default for how Solus handles API rate limits. Options: <strong class="text-[#1A1714] font-medium">Ask</strong> (prompt each time), <strong class="text-[#1A1714] font-medium">Queue</strong> (wait and retry automatically), <strong class="text-[#1A1714] font-medium">Continue</strong> (proceed without waiting), or <strong class="text-[#1A1714] font-medium">Stop</strong> (halt the task). Individual tabs can override this.'],
						['Git worktrees', 'When enabled, new sessions automatically run in an isolated git worktree so your working branch stays clean. Changes are merged back when the session completes.'],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''} {i < 2 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Review companion</h3>
				<div class="mt-3 rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
					{#each [
						['Review agent', 'Which CLI agent reviews your branch for the <a href="#review" class="text-[#C4973A] no-underline hover:underline">Review Companion</a>. Defaults to your active agent.'],
						['Review model', "The model the review agent uses. Defaults to that agent's default model."],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''} {i < 1 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Input</h3>
				<div class="mt-3 rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
					{#each [
						['Voice mode', `Enable continuous hands-free voice input. When active, Solus records after each agent reply and auto-sends on silence. Transcription runs locally via Whisper — audio never leaves your machine.`],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Tools</h3>
				<div class="mt-3 rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
					{#each [
						['Default editor', 'The editor launched when opening changed files. Auto-detected from your system — supports VS Code, vim, nvim, and helix.'],
						['Default terminal', 'Terminal app used when launching terminal-based editors. Supports the system default terminal and Ghostty.'],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''} {i < 1 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>

				<p class="mt-6 text-[14px] text-[#A09488]">Settings are persisted to disk and apply immediately — no restart required.</p>
			</section>

		</div>
	</main>
</div>
