<script lang="ts">
	import { onMount } from 'svelte';

	const sectionGroups = [
		{ label: 'Introduction', sections: [
			{ id: 'overview',        label: 'Overview' },
		]},
		{ label: 'Getting Started', sections: [
			{ id: 'getting-started', label: 'Getting Started' },
			{ id: 'sessions',        label: 'Sessions & Tabs' },
		]},
		{ label: 'Working with Agents', sections: [
			{ id: 'switching-agents', label: 'Switching Agents' },
			{ id: 'delegated-agents', label: 'Delegated Agents' },
			{ id: 'plans',           label: 'Working with Plans' },
			{ id: 'rate-limits',     label: 'Rate Limit Queueing' },
		]},
		{ label: 'Reviewing Changes', sections: [
			{ id: 'panes',           label: 'Workspace Panes' },
			{ id: 'diff',            label: 'Diff Panel' },
			{ id: 'files',           label: 'Opening Changed Files' },
			{ id: 'review',          label: 'Review Companion' },
			{ id: 'pull-request-merge', label: 'Opening & Merging Pull Requests' },
		]},
		{ label: 'Documents & Input', sections: [
			{ id: 'works',           label: 'Works' },
			{ id: 'document-editor', label: 'Document Editor' },
			{ id: 'design-mode',     label: 'Design Mode' },
			{ id: 'voice',           label: 'Voice Input' },
		]},
		{ label: 'Automation', sections: [
			{ id: 'automations',     label: 'Automations' },
			{ id: 'tasks',           label: 'Tasks' },
		]},
		{ label: 'Connections & Settings', sections: [
			{ id: 'connections',     label: 'Hosts & Connections' },
			{ id: 'settings',        label: 'Settings' },
		]},
		{ label: 'Reference', sections: [
			{ id: 'keybindings',     label: 'Keybindings' },
		]},
	];

	const sections = sectionGroups.flatMap((group) => group.sections);

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
	<title>Documentation · Solus</title>
	<meta name="description" content="How to get work done with Solus: start a session from anywhere, review plans and diffs, ship PRs, run automations, and dispatch sessions to other hosts. Plus the full keybinding reference." />
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

	<!-- Mobile TOC, visible below lg -->
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
				{#each sectionGroups as group, groupIndex}
					<p class="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-[#C4B8AE] px-3 pb-1 {groupIndex > 0 ? 'pt-3' : 'pt-1'}">{group.label}</p>
					{#each group.sections as section}
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
					<circle cx="0" cy="0" r="31.2" fill="#B45A3C" />
					<g stroke="#D97757" stroke-width="10.4" stroke-linecap="round">
						<path d="M 0,-52 A 52,52 0 0 1 52,0" />
						<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
						<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
					</g>
				</svg>
				<span class="font-[family-name:var(--font-display)] text-[14px] font-bold tracking-[-0.03em] text-[#1A1714]">Solus</span>
				<span class="text-[11px] font-medium text-[#A09488] ml-0.5">docs</span>
			</a>

			<nav class="flex flex-col">
				{#each sectionGroups as group, groupIndex}
					<p class="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-[#C4B8AE] mb-1.5 px-2 {groupIndex > 0 ? 'mt-4' : ''}">{group.label}</p>
					{#each group.sections as section}
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
				Working with Solus
			</h1>
			<p class="text-base sm:text-[15px] max-[1440px]:sm:text-[14px] text-[#6B6158] leading-relaxed max-w-[560px]">
				How to get work done with Solus: summon an agent, shape its plan, review the diff,
				ship the PR. Each section is a short recipe; the full keybinding reference is at the end.
			</p>
			<p class="text-[12px] text-[#B0A499] mt-3">Updated August 14, 2026</p>
		</div>

		<div class="flex flex-col text-base/7 sm:text-[15px] sm:leading-[1.8] max-[1440px]:sm:text-[14px] text-[#6B6158]">

			<section id="overview" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)] first:pt-0">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Overview</h2>
				<p>
					Solus is the agent development environment (ADE), the best way to produce software
					with agents. On macOS it floats above whatever you're doing, one keystroke away; from
					any browser or your phone, the same workspace follows you. The agent's work comes
					back as things you act on: plans to approve, diffs to review, PRs to merge.
				</p>
				<p class="mt-3">The whole product is one loop:</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Summon', `Press ${kbdHtml('⌥Space')} from any app, pick a project, and describe the change. See <a href="#getting-started" class="text-[#C4973A] no-underline hover:underline">Getting Started</a>.`],
						['Plan', `For bigger work, have the agent draft a plan and mark it up before any code changes. See <a href="#plans" class="text-[#C4973A] no-underline hover:underline">Working with Plans</a>.`],
						['Review', `Step through every touched file and send line-level feedback. See <a href="#diff" class="text-[#C4973A] no-underline hover:underline">Diff Panel</a> and <a href="#review" class="text-[#C4973A] no-underline hover:underline">Review Companion</a>.`],
						['Ship', `One action in the Git panel commits, pushes, and opens the pull request — message and description written for you — then merge it without leaving Solus. See <a href="#pull-request-merge" class="text-[#C4973A] no-underline hover:underline">Pull Requests</a>.`],
						['Automate', `Save the prompts you repeat and run them on a schedule. See <a href="#automations" class="text-[#C4973A] no-underline hover:underline">Automations</a>.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">
					Everything else (Works, Design Mode, voice input, remote hosts) hangs off that
					loop. Use the sidebar to jump straight to a feature.
				</p>
			</section>

			<section id="getting-started" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Getting Started</h2>
				<p>
					Press {@render kbd('⌥Space')}. The Solus panel appears above whatever you're doing;
					press it again to dismiss it. That one shortcut is the core habit.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Your first session</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Pick a project', `Press ${kbdHtml('⌘O')} and choose the directory the agent should work in.`],
						['Pick a permission mode', `Press ${kbdHtml('⌥⇧Tab')} to cycle: <strong class="text-[#1A1714] font-medium">Ask</strong> approves each action, <strong class="text-[#1A1714] font-medium">Auto</strong> runs uninterrupted, <strong class="text-[#1A1714] font-medium">Plan</strong> drafts a plan for your review first. Start with Ask; use Plan for anything non-trivial.`],
						['Prompt', `Type what you want and press ${kbdHtml('Enter')}. <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">@</code> autocompletes files; attach files or screenshots from the input bar.`],
						['Watch it work', 'Tool calls and diff previews stream in. Keep typing. Follow-ups queue for the next turn.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Pill mode vs. editor mode</h3>
				<p class="text-base/7 sm:text-[14px]">
					Two layouts; toggle with {@render kbd('⌥⇧E')}.
				</p>
				<div class="mt-4 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Pill · stay in flow</p>
						<p class="text-base/7 sm:text-[14px]">A compact strip at the bottom of your screen. Fire off a prompt, glance at progress, keep working.</p>
					</div>
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Editor · go deep</p>
						<p class="text-base/7 sm:text-[14px]">The full workspace: sidebar, panes, diff panel, project panel. Review plans and diffs here.</p>
					</div>
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Agents and models</h3>
				<p class="text-base/7 sm:text-[14px]">
					Solus drives the Claude Code and Codex CLIs you already have installed. Cycle the agent
					with {@render kbd('⌥⇧G')}, the model with {@render kbd('⌥⇧M')}, or open the model /
					reasoning menu with {@render kbd('⌥⇧Z')}. Each tab can use a different agent and model.
				</p>
			</section>

			<section id="sessions" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Sessions & Tabs</h2>
				<p>
					Each tab is an independent session with its own project, agent, model, and
					permission mode, so a refactor, a bug fix, and a question can run at once.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open and close sessions', `${kbdHtml('⌘T')} starts a new session in the current task, ${kbdHtml('⌘⇧N')} starts one without a task, and ${kbdHtml('⌘⇧W')} closes the current tab.`],
						['Move between tabs', `${kbdHtml('⌃Tab')} / ${kbdHtml('⌃⇧Tab')} cycle branch tabs; ${kbdHtml('⌥⇧N')} / ${kbdHtml('⌥⇧P')} move between sessions in a branch.`],
						['Fork a session', `Press ${kbdHtml('⌥F')} to branch the conversation into a new tab that keeps all context so far. Explore two approaches from one starting state.`],
						['Resume past work', `Press ${kbdHtml('⌘P')} and pick any previous session; it reopens with its full conversation.`],
						['Queue while busy', 'Send a message while the agent is working and it runs on the next turn.'],
						['Isolate risky work', `Press ${kbdHtml('⌥⇧B')} to run the session on an isolated git worktree; switch worktrees with ${kbdHtml('⌥⇧H')}.`],
						['Switch branches', `Pick a branch in the git dropdown to check it out for the tab. If a worktree already has that branch, Solus takes you there.`],
						['Follow the goal', `The project panel shows the session's <strong class="text-[#1A1714] font-medium">Goal</strong> card: status and progress against a token budget. Codex sessions can edit, pause, or clear it there.`],
						['Ship from the keyboard', `${kbdHtml('⌥⇧C')} commits and pushes the session's changes; ${kbdHtml('⌥⇧.')} pulls to sync. The Git panel's primary action goes further — branch, commit, push, and pull request in one step. See <a href="#pull-request-merge" class="text-[#C4973A] no-underline hover:underline">Opening &amp; Merging Pull Requests</a>.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">
					The input bar does more than text: {@render kbd('@')} opens file autocomplete,
					{@render kbd('/')} opens the slash-command menu, {@render kbd('↑')} at the start of the
					input walks your prompt history, and {@render kbd('⌥⇧=')} expands the input for long prompts.
				</p>
			</section>

			<section id="switching-agents" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Switching Agents</h2>
				<p>
					A session isn't married to the agent it started on. Press {@render kbd('⌥⇧G')} to cycle
					the active agent, or pick one from the agent chip in the input bar — mid-conversation,
					any time the agent isn't running.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Before the first message', 'Switching a session that hasn\'t started yet just swaps the agent and its default model. There is nothing to hand off.'],
						['Mid-session, it\'s a handoff', 'Solus exports the conversation so far — plus the outgoing agent\'s reasoning, when its provider saves it — and seeds the new agent with the transcript. It reads the history, then answers your next message as the next turn.'],
						['A divider marks the switch', 'A "Switched to …" line lands in the transcript at the handoff point, and the full history stays readable across segments.'],
						['Each agent keeps its thread', 'Every agent holds its own provider thread. Switch back to one you used earlier in the session and Solus restores that thread instead of starting cold.'],
						['The model follows the agent', `The session takes the new agent's default model; change it with ${kbdHtml('⌥⇧M')} or ${kbdHtml('⌥⇧Z')}.`],
						['Busy sessions wait', `You can't switch while the agent is working — stop it (${kbdHtml('⌃C')}) or let the turn finish first.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">
					Switching the agent on one session never changes other sessions — it only becomes the
					default for new ones.
				</p>
			</section>

			<section id="delegated-agents" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Delegated Agents</h2>
				<p>
					Ask your agent to delegate ("review this with a second agent", "search the repo
					with a subagent") and it hands the work off. The exchange lands in the transcript as a
					card you can follow, answer, and open.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Two ways to delegate</h3>
				<div class="mt-4 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Subagent · headless</p>
						<p class="text-base/7 sm:text-[14px]">A one-shot run in the same working directory that returns a written answer. Can be launched read-only. The card shows its prompt and its report.</p>
					</div>
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Session · a peer</p>
						<p class="text-base/7 sm:text-[14px]">A full Solus session with its own agent, model, and history. It keeps running after the exchange; open it like any other session.</p>
					</div>
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">The exchange card</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['One card per exchange', 'A delegating turn shows one card with the other agent, its status, and elapsed time. Several agents dispatched in one turn share the card.'],
						['Follow along', 'The dialogue streams into the card live.'],
						['Reply directly', 'The field at the bottom of the card messages that agent\'s session without adding a turn to yours.'],
						['Answer a blocked agent', 'If it stops to ask something, the card asks you in place, and answering unblocks it.'],
						['Open the session', `Click <strong class="text-[#1A1714] font-medium">Open session</strong> to take over the peer session in a tab of your own.`],
						['Unattended by design', 'Delegated runs never enter plan mode and never stall on permission prompts. They finish with the scope they were given.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">Delegation is the agent's call. Ask for it in your prompt ("review this with a second agent", "search the repo with a subagent") and it uses the tools it has.</p>
			</section>

			<section id="plans" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Working with Plans</h2>
				<p>
					For anything bigger than a one-liner, make the agent show its approach before any code
					changes. You mark the plan up like a PR review, so course-corrections happen before
					the work, not after.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Enter Plan mode', `Press ${kbdHtml('⌥⇧Tab')} until the permission mode reads <strong class="text-[#1A1714] font-medium">Plan</strong>, then send your prompt.`],
						['Read the plan', 'When the agent is ready, it opens the plan full-screen as Markdown.'],
						['Comment', 'Select any text to attach an inline comment to that section, or add a top-level comment for the whole plan.'],
						['Approve or reject', `Approve into Ask (${kbdHtml('⌥Y')}) or Auto (${kbdHtml('⌥A')}) mode. Your comments travel with the approval. Reject (${kbdHtml('⌥R')}) to stop the agent and redirect it.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Keeping plans around</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Pin or bookmark', `Pin a plan (${kbdHtml('⌥P')} in the workspace) to keep it on top, or bookmark it (${kbdHtml('⌥B')}) to revisit later.`],
						['Revisions', 'Updated plans keep their previous versions. Compare or revert from the revision dropdown.'],
						['Any model', 'Plan mode works with every model; Solus handles the orchestration.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">Plans are saved to disk as Markdown. Press {@render kbd('⌥⇧L')} to open the workspace and browse plans across sessions.</p>
			</section>

			<section id="rate-limits" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Rate Limit Queueing</h2>
				<p>
					When a session hits an API rate limit, Solus keeps your work. Set the default under
					Settings → <em>Rate limit behavior</em>, or override it per tab:
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
				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Knowing how much is left</h3>
				<p class="text-base/7 sm:text-[14px]">
					The project panel ({@render kbd('⌥M')}) shows a quota meter for every signed-in agent:
					how much of the <strong class="text-[#1A1714] font-medium">Session</strong> and
					<strong class="text-[#1A1714] font-medium">Weekly</strong> windows remain, with a
					countdown to each refill.
				</p>
			</section>

			<section id="panes" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Workspace Panes</h2>
				<p>
					In editor mode, plans, Works, diffs, reviews, and documents open as panes over or
					beside the conversation, so you read them without losing your place.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How panes behave</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Focus or split', `Press ${kbdHtml('⌥⇧\\')} (or use the pane header action) to move a plan, Work, automation, or review between the focused primary pane and the split side pane.`],
						['Diffs and files', `${kbdHtml('⌥⇧D')} opens the diff, ${kbdHtml('⌥⇧O')} the files pane, ${kbdHtml('⌥⇧F')} changed files, each beside the conversation so you can inspect code and keep prompting.`],
						['PR review', 'A pull request opens with the review maximized; use the Chat control to reveal the conversation beside Activity, Guide, and Diff.'],
						['One commit at a time', 'Click a commit in the Activity timeline and the Diff narrows to that commit\'s own changes. A band names the commit and takes you back to all changes. Inline comments are off while one commit is in view, because comment anchors belong to the full diff.'],
						['State stays put', 'Closing a pane restores the conversation with scroll position and drafts intact.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section id="diff" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Diff Panel</h2>
				<p>
					When the agent says it's done, verify it. Press {@render kbd('⌥⇧D')} in editor mode to
					see every file the session touched.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How it works</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Navigate files', `${kbdHtml('⌥N')} / ${kbdHtml('⌥P')} step through changed files, ${kbdHtml('⌥F')} searches, or click a file in the list.`],
						['Filter by turn', `Select a turn in the conversation, or press ${kbdHtml('⌥→')} / ${kbdHtml('⌥←')} to move through turns.`],
						['Leave comments', `Press ${kbdHtml('⌥C')} to start an inline comment on the current line.`],
						['Send feedback', `Write a general note in the feedback box, then press ${kbdHtml('⌥↵')}. Your line comments and note land in the conversation as one message.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">See the <a href="#keybindings" class="text-[#C4973A] no-underline hover:underline">Keybindings → Diff panel</a> section for the full list of shortcuts.</p>
			</section>

			<section id="files" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Opening Changed Files</h2>
				<p>
					Every edit shows an inline diff preview in the conversation. With a default editor set
					in Settings, each preview gets an <strong class="text-[#1A1714] font-medium">Open</strong>
					button that jumps to that file in your editor. Press {@render kbd('⌥⇧F')} to open every
					changed file at once.
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

			<section id="review" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Review Companion</h2>
				<p>
					Before you commit or open a PR, have a second agent review the branch (commits,
					uncommitted edits, and untracked files) and write an inline report of findings.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How to use it</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open the project panel', `Press ${kbdHtml('⌥M')} in editor mode and find the <strong class="text-[#1A1714] font-medium">Git</strong> section.`],
						['Generate a review', `Click <strong class="text-[#1A1714] font-medium">Review changes</strong>. The review runs in the background while you keep working.`],
						['Open the report', `When ready, the button becomes <strong class="text-[#1A1714] font-medium">View report</strong>.`],
						['Jump to a finding', 'Click any finding to focus that exact file and line in the diff beside it.'],
						['Regenerate', 'After more changes, click the refresh button in the companion header.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<p class="mt-5 text-[14px] text-[#A09488]">
					Pick the reviewing agent and model under
					<strong class="text-[#A09488] font-medium">Settings → Review companion</strong>; it
					defaults to your active agent and its default model.
				</p>
			</section>

			<section id="pull-request-merge" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Opening &amp; Merging Pull Requests</h2>
				<p>
					Open a pull request and merge it without opening GitHub:
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Publishing the work</h3>
				<p class="text-base/7 sm:text-[14px]">
					The Git section of the project panel ({@render kbd('⌥M')}) shows one primary action that
					reads your branch state and runs every step it needs:
				</p>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['On the default branch', `Uncommitted work becomes a feature branch first, then a commit, a push, and a pull request.`],
						['On a feature branch', `<strong class="text-[#1A1714] font-medium">Commit, push and open PR</strong>, or just <strong class="text-[#1A1714] font-medium">Commit and push</strong> once the pull request exists.`],
						['Nothing to commit', `Unpushed commits push and open the pull request; a published one opens directly.`],
						['Behind the upstream', `Sync first (${kbdHtml('⌥⇧.')}) — the action waits until the branch is up to date.`],
						['Messages are written for you', `The commit message, the branch name, and the pull-request title and description come from the change itself: commit subjects, diff statistics, and the repository pull-request template when there is one. If generation fails, Solus falls back to a plain draft from the same context.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-4 text-[14px] text-[#A09488]">
					{@render kbd('⌥⇧C')} still commits and pushes directly. Writing style, template handling,
					and the model that writes them live under
					<strong class="text-[#A09488] font-medium">Settings → Source Control</strong>.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Merging</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open the PR', 'Open the Pull Requests page from the sidebar and select the PR.'],
						['Check readiness', 'The review surface shows status, required checks, reviewers, and unresolved conversations.'],
						['Merge', 'Pick <strong class="text-[#1A1714] font-medium">Merge commit</strong>, <strong class="text-[#1A1714] font-medium">Squash</strong>, or <strong class="text-[#1A1714] font-medium">Rebase</strong> and confirm. Branch-protection refusals are reported in place.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Resolving conflicts</h3>
				<p class="text-base/7 sm:text-[14px]">
					If the PR conflicts with its base branch, choose <strong class="text-[#1A1714] font-medium">Resolve conflicts</strong>:
					Solus checks the PR out into an isolated worktree and opens an agent session on the
					conflicted files. The agent resolves, commits, and pushes. Then merge normally.
				</p>
			</section>

			<section id="works" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Works</h2>
				<p>
					Ask for a design doc, a migration guide, or a slide draft and Solus saves it as an
					editable <strong class="text-[#1A1714] font-medium">Work</strong> instead of a long
					Markdown block in the chat. Works outlive the session that created them.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open the workspace', `Press ${kbdHtml('⌥⇧L')} or click <strong class="text-[#1A1714] font-medium">Folio</strong> in the sidebar — plans, documents, and diagrams in one searchable gallery.`],
						['Edit in place', 'Open a Work to edit it in the Document Editor; saving updates the stored Work.'],
						['Copy or reuse', `Press ${kbdHtml('⌥C')} while a Work is open to copy its Markdown.`],
						['Storage', 'Works are stored locally under your Solus data directory. Documents are fully editable; slides are tracked so the app can surface and expand them.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Work modal</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while a Work is open. The workspace itself has its own set — see <a href="#keybindings" class="text-[#C4973A] no-underline hover:underline">Keybindings → Workspace</a>.</p>
				{@render kbTable([
					['⌥S', 'Save'],
					['⌥C', 'Copy to clipboard'],
					['⌘M', 'Comment on selection'],
					['⌘F', 'Find & replace'],
					['⌥G', 'Open in Google Docs'],
					['Esc', 'Close'],
				])}
			</section>

			<section id="document-editor" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Document Editor</h2>
				<p>
					Works, prompts, and notes are edited in the Document Editor. It renders Markdown
					natively; toggle the raw Markdown view with the <strong class="text-[#1A1714] font-medium">Markdown</strong>
					button in the top-right corner.
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

			<section id="design-mode" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Design Mode</h2>
				<p>
					"The button is misaligned" is a paragraph in text and two seconds with an arrow.
					Screenshot any window, draw on it, and send the image to your agent:
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How to use it</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Take a screenshot', `Press ${kbdHtml('⌥⇧S')} or click the camera icon in the input bar. Solus captures the active window and opens the annotation overlay.`],
						['Annotate', 'Draw with the left-side toolbar, then confirm. The image lands as an attachment in the input bar.'],
						['Send', 'Add any extra context and press Enter. The agent receives the annotated screenshot and your message.'],
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
					['⌘Z', 'Undo'],
					['⌘⇧Z', 'Redo'],
					['⌘↩', 'Confirm and attach annotated image'],
					['Escape', 'Cancel and discard'],
				])}

				<p class="mt-5 text-[14px] text-[#A09488]">The annotated image is composited at full screenshot resolution before being sent, so annotations are baked into the image your agent receives.</p>
			</section>

			<section id="voice" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Voice Input: Mic vs Voice Mode</h2>
				<p>
					Two voice input modes; both transcribe locally with Whisper, so audio never leaves
					your machine.
				</p>

				<div class="mt-6 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Mic · manual</p>
						<p class="text-base/7 sm:text-[14px]">Press {@render kbd('⌥⇧Space')} or click the mic icon to start. Press again to stop, or just pause for 2 seconds and recording ends automatically. Transcript is inserted for review before sending.</p>
					</div>
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Voice Mode · continuous</p>
						<p class="text-base/7 sm:text-[14px]">Enable in Settings → Input, or press {@render kbd('⌥⇧V')} while composing. Window open → record → silence → send → agent replies → record again. Hands-free loop. Hidden window cancels recording.</p>
					</div>
				</div>
			</section>

			<section id="automations" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Automations</h2>
				<p>
					An automation is a saved prompt that runs on a schedule or on demand: a daily TODO
					sweep, a nightly dependency check. Press {@render kbd('⌥⇧V')} to open the Automations
					page, then {@render kbd('⌥N')} to create one: write the prompt, pick the agent and
					model, choose a trigger, and save.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">What each automation captures</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Prompt', 'The instruction the agent runs each time.'],
						['Agent & model', 'Which agent, model, and reasoning effort. Runs execute headless in Auto permission mode.'],
						['Working directory', 'Defaults to your active project.'],
						['Max turns', 'An optional cap per run, as a guardrail.'],
						['Enabled / paused', 'Paused automations never fire on schedule.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Triggers</h3>
				{@render kbTable([
					['Manual', 'No schedule. Runs only when you click Run now or an agent triggers it.'],
					['Once', 'Run a single time at a specific date and time.'],
					['Interval', 'Run every N minutes, hours, or days.'],
					['Daily', 'Run every day at a set time.'],
					['Weekly', 'Run on a chosen weekday at a set time.'],
					['Monthly', 'Run on a chosen day of the month at a set time.'],
					['Cron', 'A raw 5-field cron expression (minute hour day-of-month month day-of-week) with an IANA timezone.'],
				])}
				<p class="mt-3 text-[14px] text-[#A09488]">Scheduled triggers fire only while Solus is open. They don't run in the background when the app is quit.</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Running & history</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Run now', 'Trigger any enabled automation immediately, regardless of schedule.'],
						['Run history', 'Each automation logs past runs with status, tool-call count, and output or error.'],
						['Open a run', 'Open a completed run as a full session to see exactly what the agent did.'],
						['Created by agents', 'Agents can create, edit, and trigger automations for you; theirs are tagged in the list.'],
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
					A task board in the project panel: track work as local tickets or synced GitHub
					Issues, and start agent sessions straight from a task so the ticket context travels
					with the work.
				</p>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Local tickets and GitHub Issues', 'Keep lightweight local tickets, or connect a repository to sync GitHub Issues into the same board. Status flows both ways.'],
						['Planning fields', 'Epics, priorities, labels, due dates, and threaded comments.'],
						['Start a session from a task', 'The ticket body and comments ride along as context.'],
						['Linked work', 'Sessions, pull requests, plans, and works stay linked to the task, so the board shows where everything stands.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {desc}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section id="connections" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Hosts & Connections</h2>
				<p>
					Any browser on your network can pick up your sessions, and other machines running the
					Solus server become <strong class="text-[#1A1714] font-medium">hosts</strong> you can
					run sessions on, all driven from the same window.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">The web UI</h3>
				<p class="text-base/7 sm:text-[14px]">
					With Solus running, open port <strong class="text-[#1A1714] font-medium">3000</strong>
					(override with <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">SOLUS_PORT</code>)
					from your phone, tablet, or another computer. The first visit shows the pairing screen.
				</p>
				<div class="mt-4 p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)] font-mono text-[13px] text-[#6B6158]">
					http://&lt;your-mac-ip&gt;:3000 &nbsp;·&nbsp; e.g. http://192.168.1.42:3000
				</div>
				<p class="mt-3 text-[14px] text-[#A09488]">
					Every address Solus is reachable from (localhost, LAN, Tailscale / VPN) is listed in
					<strong class="text-[#A09488] font-medium">Settings → Connections</strong>.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Pairing a device</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Generate a pair code', `In <strong class="text-[#1A1714] font-medium">Settings → Connections</strong>, click <strong class="text-[#1A1714] font-medium">Generate pair code</strong>. You get a 6-digit code plus pairing links, expiring after 5 minutes.`],
						['Connect from the browser', `Open a pairing link on the device (AirDrop, Messages, etc.) and the address and token are read from the URL. Or use <strong class="text-[#1A1714] font-medium">Manual setup</strong> and enter the address and code.`],
						['Name the device', `Optional; defaults to your browser and OS.`],
						['Stay paired', 'The browser keeps a long-lived token and reconnects on every later visit until you revoke it.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-4 text-[14px] text-[#A09488]">
					The web UI reconnects automatically after sleep or network changes, supports web push
					notifications on capable browsers, and always opens links on the device you're holding,
					never on the remote machine.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Adding a host</h3>
				<p class="text-base/7 sm:text-[14px]">
					A host is any other machine running the Solus server. Add one from the host directory:
				</p>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Pair over SSH', `Point Solus at <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">user@host</code> and it connects, installs the Solus server, and pairs automatically. No SSH? Enter the server's address and pair code by hand.`],
						['Claim a fresh server', `A server you installed yourself prints a claim link, code, and QR on <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus claim</code>; opening the link takes ownership.`],
						['Automatic setup', `Once paired, Solus provisions git credentials from your GitHub connection, installs the agent CLIs, and walks you through signing into them.`],
						['Readiness at a glance', `The host directory shows what's installed and signed in, with one-click repairs for anything missing.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Run on: choosing where a session runs</h3>
				<p class="text-base/7 sm:text-[14px]">
					Every new session has a <strong class="text-[#1A1714] font-medium">Run on</strong> picker
					in its header. Pick any host before the session starts; Solus remembers the choice per
					repository.
				</p>
				<p class="text-base/7 sm:text-[14px] mt-3">
					Running on another host is a <strong class="text-[#1A1714] font-medium">dispatch</strong>.
					It carries the <em>repository</em>, not your working tree:
				</p>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['A fresh checkout, every time', `The host clones or syncs from the git remote and cuts a fresh worktree from the default branch.`],
						['Uncommitted changes stay put', `Unpushed edits don't travel. Commit and push first if you want them there.`],
						['Always isolated', `A dispatched session always runs in its own worktree.`],
						['Work comes back as a PR', `Commit → push → pull request, same as local work.`],
						['Needs a git remote', `No remote, nothing to clone. Open the folder directly on that host instead.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-4 text-[14px] text-[#A09488]">
					You can also open a project that already lives on a host from the open-project dialog;
					it behaves like a local one. Once a session has started, its host is fixed.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Managing devices</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Connected devices', 'The Connections panel lists every paired device with its label and last-connected time.'],
						['Revoke access', 'Revoking a device invalidates its token immediately; it must re-pair to reconnect.'],
						['Multiple servers', 'The web app remembers every server you\'ve paired with; remove one with its ✕.'],
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
						['Local only', 'Traffic stays on your network. Nothing routes through external servers.'],
						['Session tokens', 'Each device holds its own token; revoking one affects nothing else.'],
						['Tailscale / VPN', 'Use a Tailscale pairing link to reach your desktop from outside your LAN.'],
						['Loopback (same machine)', `<code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">http://localhost:3000</code> skips pairing in development mode only; production builds always pair.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Self-hosted server</h3>
				<p class="text-base/7 sm:text-[14px]">
					Run the standalone server on any macOS or Linux box and reach it entirely from the
					browser. Install through Homebrew:
				</p>
				<div class="mt-4 p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)] font-mono text-[13px] text-[#6B6158] whitespace-pre-wrap">brew install Ashton-Sidhu/tap/solus   # CLI + vendored server runtime
brew services start solus             # run the daemon in the background
solus claim                           # claim the server from this machine</div>
				<ul class="mt-4 flex flex-col gap-3 list-none p-0">
					{#each [
						['Manage from the CLI', `<code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus start</code>, <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus logs</code>, and <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus update</code> run, tail, and upgrade the daemon. Data lives under <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">~/.solus</code>.`],
						['Claim it once', `<code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus claim</code> prints a link, code, and QR; open it to take ownership, then pair devices normally.`],
						['Stays updated', 'Upgrade with <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">brew upgrade solus</code>, or <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus update</code> for tarball installs.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section id="settings" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Settings</h2>
				<p>
					Open Settings with {@render kbd('⌘,')}. All preferences are stored locally on your machine.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Display</h3>
				<div class="mt-3 rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
					{#each [
						['Editor mode', `Full editor layout or the compact pill overlay. Toggle with <kbd class="inline-flex items-center px-[5px] py-[2px] rounded-[5px] text-[11px] font-mono font-medium text-[#1A1714] border border-[rgba(0,0,0,0.14)] bg-[rgba(0,0,0,0.05)] leading-none shadow-[0_1px_0_rgba(0,0,0,0.08)]">⌥⇧E</kbd>.`],
						['Dark theme', 'Light or dark appearance, applied immediately.'],
						['Font size', 'Base font size for messages and code blocks. Minimum 8px.'],
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
						['Default agent', 'The agent for new sessions; unavailable agents are disabled.'],
						['Rate limit behavior', 'Ask, Queue, Continue, or Stop. See <a href="#rate-limits" class="text-[#C4973A] no-underline hover:underline">Rate Limit Queueing</a>. Tabs can override it.'],
						['Git worktrees', 'New sessions run in an isolated git worktree; changes merge back when the session completes.'],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''} {i < 2 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Text generation</h3>
				<div class="mt-3 rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
					{#each [
						['Text-generation model', 'The model behind short background writing: session names, metadata, and generated Git messages.'],
						['Backup text-generation model', 'Used when the first choice is not installed on the host. Solus keeps your selection and reports the model it actually used.'],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''} {i < 1 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>
				<p class="mt-3 text-[14px] text-[#A09488]">
					These are host settings: a remote client uses the models installed on the host the
					session runs on.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Source control</h3>
				<div class="mt-3 rounded-xl border border-[rgba(0,0,0,0.07)] overflow-hidden">
					{#each [
						['Source control writing style', '<strong class="text-[#1A1714] font-medium">Repository conventions</strong> matches each repository\'s recent commit subjects, <strong class="text-[#1A1714] font-medium">Conventional Commits</strong> applies <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">feat:</code> / <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">fix:</code> prefixes, and <strong class="text-[#1A1714] font-medium">Custom instructions</strong> uses your own direction.'],
						['Follow pull-request templates', 'Structure pull-request descriptions with the repository template when one exists.'],
						['Source-control writer model', 'Optional override for commits, branch names, and pull requests. Off uses the text-generation model.'],
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
						['Voice mode', `Continuous hands-free voice input. See <a href="#voice" class="text-[#C4973A] no-underline hover:underline">Voice Input</a>.`],
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
						['Default editor', 'The editor for opening changed files: VS Code, vim, nvim, or helix (auto-detected).'],
						['Default terminal', 'System terminal or Ghostty. Terminals open in a shared <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus</code> tmux session, so they stay in one place and survive closing the window; requires <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">tmux</code>.'],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''} {i < 1 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>

				<p class="mt-6 text-[14px] text-[#A09488]">Settings are persisted to disk and apply immediately. No restart required.</p>
			</section>

			<section id="keybindings" class="reveal py-10">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Keybindings</h2>
				<p>
					The full reference, matching the app's defaults. Learn these first: summon
					({@render kbd('⌥Space')}), focus input ({@render kbd('⌘L')}), cycle permission mode
					({@render kbd('⌥⇧Tab')}), open the diff ({@render kbd('⌥⇧D')}). Every binding is
					editable in <strong class="text-[#1A1714] font-medium">Settings → Keybindings</strong>;
					web-client variants are noted where they differ.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Global</h3>
				<p class="text-base/7 sm:text-[14px]">These work system-wide, even when Solus is hidden.</p>
				{@render kbTable([
					['⌥Space', 'Toggle window'],
					['⌘⇧K', 'Toggle window (alternative)'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">General</h3>
				{@render kbTable([
					['⌘O', 'Open project on current host (web: ⌥O)'],
					['⌘⇧O', 'Open project'],
					['⌘,', 'Open settings'],
					['⌘L', 'Focus input (web: ⌥L)'],
					['⌘K', 'Command palette'],
					['⌘/', 'Keyboard shortcuts help'],
					['⌥⇧Q', 'Toggle quick actions'],
					['⌥⇧`', 'Open terminal'],
					['⌥⇧C', 'Commit and push'],
					['⌥⇧.', 'Sync (pull)'],
					['⌥⇧X', 'Pin / unpin session'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Tasks</h3>
				{@render kbTable([
					['⌘N', 'New task (web: ⌥⇧N)'],
					['⌘T', 'New session in task (web: ⌥⇧T)'],
					['⌘⇧N', 'New session without task'],
					['⌥⇧T', 'Open tasks'],
					['⌥⇧F', 'Task picker'],
					['⌃/', 'Focus sidebar task search'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Tabs</h3>
				{@render kbTable([
					['⌥F', 'Fork session'],
					['⌥⇧/', 'Toggle split chat'],
					['⌃Tab / ⌃⇧Tab', 'Next / previous branch tab (web: ⌥⇧→ / ⌥⇧←)'],
					['⌥⇧N / ⌥⇧P', 'Next / previous session in branch'],
					['⌘⇧W', 'Close tab (web: ⌥⇧W)'],
					['⌥⇧U', 'Group tabs by status'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">View</h3>
				{@render kbTable([
					['⌥⇧E', 'Toggle editor / pill mode'],
					['⌥⇧D', 'Toggle diff panel'],
					['⌥M', 'Toggle project panel'],
					['⌥⇧L', 'Open workspace (plans, documents, diagrams)'],
					['⌥⇧O', 'Open files pane'],
					['⌥⇧\\', 'Open pane in split'],
					['⌥⇧V', 'Open automations'],
					['⌘B', 'Toggle sidebar'],
					['⌥⇧=', 'Expand / collapse input'],
					['⌘= / ⌘- / ⌘0', 'Zoom in / out / reset (desktop only)'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Compose</h3>
				{@render kbTable([
					['⌥⇧A', 'Attach file'],
					['⌥⇧S', 'Take screenshot'],
					['⌥⇧I', 'Design annotation mode'],
					['⌘⇧S', 'Save prompt'],
					['⌥⇧K', 'Saved prompts'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Agent</h3>
				{@render kbTable([
					['⌥⇧Tab', 'Cycle permission mode (Ask → Auto → Plan)'],
					['⌥⇧M', 'Cycle AI model'],
					['⌥⇧G', 'Cycle agent (hands the session off — see Switching Agents)'],
					['⌥⇧Z', 'Open model / reasoning menu'],
					['⌥⇧,', 'Open run picker'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Conversation</h3>
				{@render kbTable([
					['⌥H', 'Scroll to first message'],
					['⌥E', 'Scroll to bottom'],
					['⌘F', 'Find in conversation'],
					['⌥⇧F', 'Open changed files'],
					['⌃C', 'Stop agent'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Navigation</h3>
				{@render kbTable([
					['⌘P', 'Session picker (web: ⌥⇧R)'],
					['⌥⇧J', 'Session picker (alternative)'],
					['⌘[ / ⌘]', 'Back / forward'],
					['⌘⇧F', 'Search in project'],
					['⌘E', 'Go to file'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Voice</h3>
				{@render kbTable([
					['⌥⇧Space', 'Start / finish voice recording'],
					['⌥⇧V', 'Toggle voice mode (while composing)'],
				])}
				<p class="text-base/7 sm:text-[14px] mt-2 text-[#A09488]">Voice Mode (continuous, hands-free) can also be enabled in <strong class="text-[#A09488] font-medium">Settings → Input</strong>.</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Automations</h3>
				<p class="text-base/7 sm:text-[14px]">Open the Automations page with {@render kbd('⌥⇧V')}. These shortcuts are active while it's open.</p>
				{@render kbTable([
					['⌥⇧V', 'Open / close automations'],
					['⌥N', 'New automation'],
					['Esc', 'Back to list / close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Git</h3>
				{@render kbTable([
					['⌥⇧B', 'Toggle worktree mode'],
					['⌥⇧H', 'Switch worktree'],
					['⌥W', 'Continue in worktree'],
					['⌥⇧Y', 'Open worktree in terminal'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Pull requests</h3>
					<p class="text-base/7 sm:text-[14px]">These shortcuts are active while the Pull Requests page is open.</p>
					{@render kbTable([
						['⌥A', 'Approve pull request'],
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

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Plan review</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while a plan is awaiting your decision.</p>
				{@render kbTable([
					['⌥Y', 'Approve (ask mode)'],
					['⌥A', 'Approve (auto mode)'],
					['⌥R', 'Reject'],
					['⌥V', 'Reject with feedback'],
					['⌥L', 'Focus comment field'],
					['⌥W', 'Toggle worktree'],
					['⌥D', 'Collapse / expand action bar'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Plan modal</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while a plan is open.</p>
				{@render kbTable([
					['⌥S', 'Save / done editing'],
					['⌥C', 'Copy plan to clipboard'],
					['⌥B', 'Save for later (bookmark)'],
					['⌥M', 'Toggle comments'],
					['⌘M', 'Comment on selection'],
					['⌥O', 'Resume session'],
					['⌘F', 'Find & replace'],
					['⌥G', 'Open in Google Docs'],
					['⌘⌥\\', 'Pin table of contents'],
					['Esc', 'Close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Workspace</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while the workspace is open ({@render kbd('⌥⇧L')}).</p>
				{@render kbTable([
					['⌥⇧L', 'Open / close workspace'],
					['/ (slash)', 'Focus search'],
					['↑ / ↓', 'Navigate items'],
					['Enter', 'Open item'],
					['⇧Enter', 'Resume session'],
					['⌥P', 'Pin / unpin'],
					['Space', 'Peek'],
					['Esc', 'Close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Diff panel</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while the diff panel is open.</p>
				{@render kbTable([
					['⌥⇧D', 'Toggle diff panel'],
					['⌥M', 'Maximize / restore panel'],
					['⌥R', 'Refresh diff'],
					['⌥→ / ⌥←', 'Next / previous turn'],
					['⌥N / ⌥P', 'Next / previous file'],
					['⌘F or ⌥F', 'Find in diff'],
					['⌥T', 'Toggle file tree'],
					['⌥V', 'Toggle split / unified view'],
					['⌥H', 'Toggle token highlighting'],
					['⌥C', 'Start comment on current line'],
					['⌥] / ⌥[', 'Next / previous comment'],
					['⌥↵', 'Send diff feedback to session'],
					['⌘⇧↵', 'Send feedback to a new session from feedback box'],
					['Esc', 'Close panel / clear selection'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Files pane</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while the files pane is open ({@render kbd('⌥⇧O')}).</p>
				{@render kbTable([
					['/ (slash)', 'Focus search'],
					['⌥J / ⌥K', 'Next / previous file'],
					['⌥T', 'Toggle file tree'],
					['Esc', 'Close'],
				])}
			</section>

		</div>
	</main>
</div>
