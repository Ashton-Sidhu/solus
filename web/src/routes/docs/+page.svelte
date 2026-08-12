<script lang="ts">
	import { onMount } from 'svelte';

	const sections = [
		{ id: 'overview',        label: 'Overview' },
		{ id: 'getting-started', label: 'Getting Started' },
		{ id: 'sessions',        label: 'Sessions & Tabs' },
		{ id: 'delegated-agents', label: 'Delegated Agents' },
		{ id: 'plans',           label: 'Working with Plans' },
		{ id: 'panes',           label: 'Workspace Panes' },
		{ id: 'diff',            label: 'Diff Panel' },
		{ id: 'files',           label: 'Opening Changed Files' },
		{ id: 'search',          label: 'Searching Your Project' },
		{ id: 'review',          label: 'Review Companion' },
		{ id: 'pull-request-merge', label: 'Merging Pull Requests' },
		{ id: 'works',           label: 'Works' },
		{ id: 'document-editor', label: 'Document Editor' },
		{ id: 'design-mode',     label: 'Design Mode' },
		{ id: 'voice',           label: 'Voice Input' },
		{ id: 'automations',     label: 'Automations' },
		{ id: 'tasks',           label: 'Tasks' },
		{ id: 'rate-limits',     label: 'Rate Limit Queueing' },
		{ id: 'connections',     label: 'Hosts & Connections' },
		{ id: 'settings',        label: 'Settings' },
		{ id: 'keybindings',     label: 'Keybindings' },
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
	<meta name="description" content="How to get work done with Solus — start a session from anywhere, review plans and diffs, ship PRs, run automations, and dispatch sessions to other hosts. Plus the full keybinding reference." />
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

			<p class="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-[#C4B8AE] mb-2.5 px-2">Guide</p>
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
				Working with Solus
			</h1>
			<p class="text-base sm:text-[15px] max-[1440px]:sm:text-[14px] text-[#6B6158] leading-relaxed max-w-[560px]">
				A walkthrough of Solus the way you'll actually use it — summon an agent from anywhere,
				shape its plan, review every change, ship the PR, and hand the recurring stuff to
				automations. The full keybinding reference is at the end.
			</p>
			<p class="text-[12px] text-[#B0A499] mt-3">Updated August 5, 2026</p>
		</div>

		<div class="flex flex-col text-base/7 sm:text-[15px] sm:leading-[1.8] max-[1440px]:sm:text-[14px] text-[#6B6158]">

			<section id="overview" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)] first:pt-0">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Overview</h2>
				<p>
					Solus is a native macOS overlay for AI coding agents. It floats above whatever you're
					doing — your IDE, a browser, a design tool — and is one keystroke away at all times.
					You never switch to a terminal to talk to an agent, and the agent's work comes back to
					you as things you can act on: plans to approve, diffs to review, PRs to merge.
				</p>
				<p class="mt-3">
					A typical loop looks like this: summon Solus, describe the change, review the plan it
					drafts, watch the diff as it works, send line-level feedback, then commit and merge —
					all without leaving the panel. Everything below follows that loop in order.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Multi-tab sessions', 'Run independent agent sessions side by side, each with its own working directory and permission mode.'],
						['Delegated agents', 'Your agent can hand a scoped task to another agent — a headless subagent, or a full session of its own — and the exchange lands in the transcript as a card you can open, follow, and answer.'],
						['Plan mode', "Review your agent's plan before it executes. Annotate with inline comments, then approve or reject. Pin or save plans for later reference and browse revision history when the plan changes."],
						['Workspace panes', 'Open plans, Works, automations, reviews, changed files, and diffs as focused panes or beside the active conversation. Closing a pane returns to the same chat with scroll position and drafts preserved.'],
						['Diff panel', 'Review every file your agent touched in a side panel. Navigate between files, leave line-level comments, and send annotated feedback back in one click.'],
						['Review companion', "A second agent reviews your branch's changes and writes an inline report — grouped findings you can click to jump straight to the relevant hunk in the diff."],
						['Pull request merging', 'Merge an individual pull request with a merge commit, squash, or rebase. Conflicted PRs can be handed to an agent in an isolated worktree.'],
						['Works', 'Generated documents and slides are saved as Works. Open the gallery to search, edit, copy, or delete them later.'],
						['Design Mode', 'Take a screenshot, draw rectangles, arrows, pins, and text annotations on it, then send the annotated image directly to your agent — no screenshots app needed.'],
						['Voice input', 'Dictate prompts hands-free with local Whisper transcription — audio never leaves your machine.'],
						['Automations', 'Save a prompt and run it on a schedule — daily, weekly, on an interval, or a raw cron expression — or trigger it on demand. Agents can create automations for you too.'],
						['Tasks', 'A project-scoped board of local tickets and synced GitHub Issues. Every session belongs to a task, so the ticket, the branch, the PR, and every attempt at the work sit in one place.'],
						['Project search', 'Search file contents across the project, or jump straight to a file by name, without leaving the panel.'],
						['File & screenshot attachments', 'Attach files or screenshots directly in the input bar.'],
						['Session history', 'Resume past sessions or pick up where you left off.'],
						['Hosts & connections', 'Pair your phone or another browser with your desktop, add other machines as hosts, and choose which host each session runs on.'],
						['Rate limit queueing', 'Automatically wait out rate limits and re-send without losing your prompt — and watch how much of each quota window is left before you get there.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {desc}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section id="getting-started" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Getting Started</h2>
				<p>
					You're mid-task in your editor and need an agent. Press {@render kbd('⌥Space')} — the
					Solus panel appears above whatever you're doing. Press it again and it steps out of the way.
					That one shortcut is the core habit; everything else builds on it.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Your first session</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Pick a project', `Press ${kbdHtml('⌘O')} and choose the directory the agent should work in. Each tab remembers its own project.`],
						['Choose how much rope to give it', `Press ${kbdHtml('⌥⇧Tab')} to cycle the permission mode: <strong class="text-[#1A1714] font-medium">Ask</strong> pauses for your approval before each action, <strong class="text-[#1A1714] font-medium">Auto</strong> runs uninterrupted, and <strong class="text-[#1A1714] font-medium">Plan</strong> makes the agent draft a full plan for your review before touching anything. Ask is a good default while you build trust; Plan is the right choice for anything non-trivial.`],
						['Say what you want', `Type your prompt and press ${kbdHtml('Enter')}. Reference files by typing <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">@</code> for autocomplete, or attach files and screenshots straight from the input bar.`],
						['Watch it work', 'Tool calls, edits, and diff previews stream into the conversation as the agent works. You can keep typing — follow-ups queue up naturally.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Pill mode vs. editor mode</h3>
				<p class="text-base/7 sm:text-[14px]">
					Solus has two layouts, and you'll move between them constantly with {@render kbd('⌥⇧E')}.
				</p>
				<div class="mt-4 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Pill · stay in flow</p>
						<p class="text-base/7 sm:text-[14px]">A compact strip at the bottom of your screen. Fire off a prompt, glance at progress, and get back to what you were doing. Built for multitasking while agents run in the background.</p>
					</div>
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Editor · go deep</p>
						<p class="text-base/7 sm:text-[14px]">A full workspace with the sidebar, workspace panes, the diff panel, and the project panel. This is where you review plans, read diffs, and drive a session with full attention.</p>
					</div>
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Agents and models</h3>
				<p class="text-base/7 sm:text-[14px]">
					Solus drives the agent CLIs you already have installed — Claude Code and Codex — and
					auto-detects which are available. Cycle the agent with {@render kbd('⌥⇧G')}, the model with
					{@render kbd('⌥⇧M')}, and open the model / reasoning menu with {@render kbd('⌥⇧Z')}. Each
					tab can use a different agent and model.
				</p>
			</section>

			<section id="sessions" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Sessions & Tabs</h2>
				<p>
					Real work rarely fits in one conversation. In Solus each tab is an independent session —
					its own project, agent, model, and permission mode — so a refactor, a bug fix, and a
					code question can all run at once without stepping on each other.
				</p>
				<p class="mt-3">
					Sessions also belong to something. Starting one creates or joins a
					<a href="#tasks" class="text-[#C4973A] no-underline hover:underline">task</a>, so a second
					attempt at the same piece of work lands beside the first instead of becoming an
					unrelated tab. {@render kbd('⌘T')} opens a session in the task you're already in,
					{@render kbd('⌘N')} starts a fresh task, and {@render kbd('⌘⇧N')} opens a session with
					no task at all when you just want to ask something.
				</p>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open and close tabs', `${kbdHtml('⌘T')} opens a new session, ${kbdHtml('⌥⇧W')} closes the current one, and ${kbdHtml('⌥⇧N')} / ${kbdHtml('⌥⇧P')} move between them.`],
						['Fork a session', `Press ${kbdHtml('⌥F')} to branch the current conversation into a new tab. The fork keeps all context up to that point — useful when you want to explore two approaches from the same starting state.`],
						['Resume past work', `Press ${kbdHtml('⌥⇧R')} to open the session history picker and jump back into any previous session with its full conversation intact.`],
						['Queue while busy', 'Sending a message while the agent is working queues it for the next turn — you never have to wait for a stopping point to say the next thing.'],
						['Isolate risky work', `Toggle worktree mode with ${kbdHtml('⌥⇧B')} to run the session on an isolated git worktree, keeping your working branch clean while the agent experiments. Switch between worktrees with ${kbdHtml('⌥⇧H')}.`],
						['Switch branches from the picker', `Picking a branch in the git dropdown checks it out for the tab. If that branch is already checked out in a worktree, Solus takes you to that worktree instead of cutting a second one.`],
						['Follow the goal', `Once a session has an objective, the project panel shows it as a <strong class="text-[#1A1714] font-medium">Goal</strong> card with its status and progress against a token budget. Codex sessions can edit, pause, resume, or clear the goal from that card.`],
						['Ship from the keyboard', `${kbdHtml('⌥⇧C')} commits and pushes the session's changes; ${kbdHtml('⌥⇧.')} pulls to sync.`],
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

			<section id="delegated-agents" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Delegated Agents</h2>
				<p>
					Some work is better handed off than done in the main thread — a wide search, an
					independent review, a second opinion. Your agent can delegate, and Solus renders the
					hand-off in the transcript instead of hiding it: you see what was asked, who is working
					on it, and what came back.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Two ways to delegate</h3>
				<div class="mt-4 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Subagent · headless</p>
						<p class="text-base/7 sm:text-[14px]">A one-shot run in the same working directory that returns a written answer. It can be launched read-only, so it explores without touching files. The card shows the prompt it was given and the report it returned.</p>
					</div>
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Session · a peer</p>
						<p class="text-base/7 sm:text-[14px]">A full Solus session of its own — its own agent, model, and history — that your agent starts or messages. It keeps running after the exchange, and you can open it like any other session.</p>
					</div>
				</div>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">The exchange card</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['One card per exchange', 'A turn that delegates shows a single card with the other agent, its status, and how long it has been working — not one card per message. If several agents were dispatched in the same turn, they share one card and the tab row is the roster.'],
						['Follow along', 'The dialogue streams into the card as it happens, so you can read the hand-off without leaving the conversation.'],
						['Reply directly', 'The field at the bottom of the card goes straight to that agent\'s session — it doesn\'t add a turn to your own conversation. On a multi-agent card you can send the same note to everyone still working.'],
						['Answer a blocked agent', 'If the other agent stops to ask something, the card asks you the question in place. Answering unblocks it without opening its session.'],
						['Open the session', `Use <strong class="text-[#1A1714] font-medium">Open session</strong> on the card to take over the peer session in a tab of your own.`],
						['Unattended by design', 'A delegated run has nobody to approve a plan, so it never enters plan mode and never stalls on a permission prompt — it proceeds with the scope it was given and reports back.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">Delegation is the agent's call — ask for it in your prompt ("review this with a second agent", "search the repo with a subagent") and it uses the tools it has.</p>
			</section>

			<section id="plans" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Working with Plans</h2>
				<p>
					For anything bigger than a one-liner, you want to see the approach before code changes.
					In Plan mode your agent drafts a full plan first — and Solus turns that plan into a
					document you can mark up like a PR review, so course-corrections happen before the work,
					not after.
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

			<section id="panes" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Workspace Panes</h2>
				<p>
					Once a session is producing things — a plan, a diff, a review report, a document — you
					need to read them without losing the conversation. In editor mode Solus keeps the active
					conversation mounted while those surfaces open as panes: cover the chat for focused
					reading, or sit beside it for side-by-side work.
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

			<section id="diff" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Diff Panel</h2>
				<p>
					The agent says it's done — now you verify. The diff panel shows every file your agent
					touched in the current session. Open it with {@render kbd('⌥⇧D')} (editor mode) to review
					changes file by file, leave line-level comments, and send consolidated feedback back
					without switching context.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How it works</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Open the panel', `Press ${kbdHtml('⌥⇧D')} in editor mode, or click the diff button in the editor toolbar.`],
						['Navigate files', `Use ${kbdHtml('⌥⇧F')} and ${kbdHtml('⌥⇧B')} to step through each changed file, search files with ${kbdHtml('⌥F')}, or click a file in the file list.`],
						['Filter by turn', `Select a specific turn in the conversation, or press ${kbdHtml('⌥⇧→')} and ${kbdHtml('⌥⇧←')} to move through turns.`],
						['Leave comments', `Press ${kbdHtml('⌥⇧C')} to start an inline comment on the current line. Comments are attached to the specific file and line range.`],
						['Send feedback', `Add a general comment in the feedback box and press ${kbdHtml('⌥⇧↵')} from anywhere in the panel, or ${kbdHtml('⌘↵')} while focused in the feedback box. Your line comments and general note land in the conversation as one structured message.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">The summary card</h3>
				<p class="text-base/7 sm:text-[14px]">
					A finished turn ends with a card saying how many files changed. Expand it and it becomes
					a directory tree rather than a flat list, so a sweep across three hundred files is still
					a handful of rows — a folder with one child folds into its parent, and every folder
					starts closed. Clicking a file opens that file's diff beside the conversation; clicking
					the count opens the whole change.
				</p>

				<p class="mt-5 text-[14px] text-[#A09488]">See the <a href="#keybindings" class="text-[#C4973A] no-underline hover:underline">Keybindings → Diff panel</a> section for the full list of shortcuts.</p>
			</section>

			<section id="files" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Opening Changed Files</h2>
				<p>
					Sometimes a diff isn't enough and you want the file in your own editor. Whenever your
					agent edits or writes a file, a diff preview appears inline in the conversation.
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

			<section id="search" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Searching Your Project</h2>
				<p>
					Half of reviewing an agent's work is checking the code it didn't touch — the caller it
					forgot, the other place that string appears. Two overlays answer that without a detour
					through your editor, and both search the session's own checkout: its worktree when the
					session runs in one, the project root otherwise.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">How to use it</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Search contents', `Press ${kbdHtml('⌘⇧F')} to search across every file in the project. Results stream in as you type, grouped by file with the matching line in context.`],
						['Narrow the match', `Toggle ${kbdHtml('⌥C')} for case-sensitive, ${kbdHtml('⌥W')} for whole-word, and ${kbdHtml('⌥R')} to treat the query as a regular expression.`],
						['Go to file', `Press ${kbdHtml('⌘E')} and type part of a path — the picker matches fuzzily, so <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">rndctx</code> finds <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">renderer/contexts</code>.`],
						['Open a result', `${kbdHtml('Enter')} opens the file in the preview pane, scrolled to the matching line.`],
						['Find within a file', `With a file open, ${kbdHtml('⌘F')} finds inside it and steps through the hits.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-5 text-[14px] text-[#A09488]">A content search answers with what it has found so far rather than walking the whole tree while you're still typing, so results keep up with the query.</p>
			</section>

			<section id="review" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Review Companion</h2>
				<p>
					Before you commit or open a PR, get a second opinion. The Review Companion turns a second
					agent loose on your branch. It reviews everything that changed — commits on the branch,
					uncommitted edits, and untracked files — and writes an inline report of grouped findings.
					Each finding links directly to the relevant hunk, so a click jumps you to that file and
					line in the diff.
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
					The last step of the loop doesn't require GitHub's UI either. Solus can merge an
					individual pull request directly from its review surface. Choose a merge commit,
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

			<section id="works" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Works</h2>
				<p>
					Not everything an agent produces is code. When you ask for a design doc, a migration
					guide, or a slide draft, Solus extracts it from the chat, saves it to disk, and shows it
					as an editable <strong class="text-[#1A1714] font-medium">Work</strong> instead of leaving
					a long Markdown block in the conversation. Works outlive the session that created them.
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
				<p class="text-base/7 sm:text-[14px]">
					Hovering a row shows a peek card — the first sentences of the document plus its outline —
					so you can tell two similar drafts apart without opening either. {@render kbd('Space')}
					does the same on the focused row, so the keyboard never needs a hover to get there.
				</p>
				<p class="text-base/7 sm:text-[14px] mt-3">These shortcuts are active while the Works gallery is open ({@render kbd('⌥⇧;')}).</p>
				{@render kbTable([
					['⌥⇧;', 'Open / close gallery'],
					['/ (slash)', 'Focus search'],
					['↑ / ↓', 'Navigate Works'],
					['Space', 'Peek at the selected Work'],
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
					The Document Editor is where you edit Works and write structured prompts, plans, and notes.
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

			<section id="design-mode" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Design Mode</h2>
				<p>
					"The button is misaligned" is a paragraph in text and two seconds with an arrow. Design
					Mode lets you take a screenshot of any window, annotate it with drawing tools, and send
					the annotated image directly to your agent — all without leaving Solus. It's the fastest
					way to describe a UI bug, highlight a layout issue, or point your agent at exactly what
					needs changing.
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
					Long prompts are often easier to say than to type. Solus has two voice input modes, and
					both transcribe locally using Whisper — audio never leaves your machine.
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
					Some of your work repeats: a daily TODO sweep, a nightly dependency check, a weekly
					changelog draft. An automation is a saved prompt that runs on a schedule or on demand,
					so the agent does that work unattended. Open the Automations page with {@render kbd('⌥⇧V')} or the
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
					An agent session is an attempt at something, and attempts pile up: you try a fix, it
					isn't right, you try again tomorrow with a fresh conversation. A task is the thing
					those attempts are attempts <em>at</em> — the ticket, the branch, the PR, and every
					session that worked on it, in one place. Open the board with {@render kbd('⌥⇧T')} or the
					<strong class="text-[#1A1714] font-medium">Tasks</strong> entry in the sidebar.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Sessions live inside tasks</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Start a task', `${kbdHtml('⌘N')} opens a session in a brand-new task. You don't have to name it first — the task takes its title from your prompt, and you can rename it later.`],
						['Add an attempt', `${kbdHtml('⌘T')} starts another session inside the task you're already working in. Both attempts hang off the same ticket in the sidebar, so the second one knows what the first one tried.`],
						['Skip the ticket', `${kbdHtml('⌘⇧N')} opens a session with no task attached — right for a question you're not going to come back to.`],
						['The agent knows the ticket', 'A session started on a task gets the task packet — title, status, description, labels, comments, subtasks, and a summary of prior attempts — so you never re-explain the ticket in your first message.'],
						['Branch and PR come back', "The branch a session works on and the pull request it opens are captured onto the task automatically, so the ticket ends up pointing at the work rather than the other way round."],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">The board</h3>
				<p class="text-base/7 sm:text-[14px]">
					The Tasks page is scoped to one project at a time — it follows the project you're working
					in, or pin another from the header switcher. It has two layouts and two views.
				</p>
				<div class="mt-4 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">List · grouped</p>
						<p class="text-base/7 sm:text-[14px]">Tasks grouped by lifecycle state, sorted by last update, priority, or due date. Opens on live work — Done and Closed stay folded away until you ask for them.</p>
					</div>
					<div class="p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)]">
						<p class="text-[12px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-2">Board · kanban</p>
						<p class="text-base/7 sm:text-[14px]">The same tasks as columns you drag between — dropping a card writes its status. Reorder within a column to say what you're doing next; placed cards lead the column from then on.</p>
					</div>
				</div>
				<ul class="mt-5 flex flex-col gap-3 list-none p-0">
					{#each [
						['Statuses', 'Six states, shared by local tasks and synced tickets alike: <strong class="text-[#1A1714] font-medium">Inbox</strong> (untriaged), <strong class="text-[#1A1714] font-medium">To do</strong>, <strong class="text-[#1A1714] font-medium">In progress</strong>, <strong class="text-[#1A1714] font-medium">In review</strong>, <strong class="text-[#1A1714] font-medium">Done</strong>, and <strong class="text-[#1A1714] font-medium">Dropped</strong>. Each one has its own glyph, so status never rides on colour alone.'],
						['Priority and due dates', 'Urgent through Low, plus a target date. Sorting by either answers "what\'s next"; an overdue task is called out in place.'],
						['Epics', 'Group related tasks under a parent epic. Subtasks roll up under it in the list and in the sidebar, and a session working a subtask is told about its siblings.'],
						['Filters', 'Narrow to tasks with an agent currently running, overdue tasks, or assigned ones. Search is focused the moment the page opens, so you can start typing a title straight away.'],
						['Inbox', 'A personal queue beside the project list: what came in and what is waiting on you, rather than the whole board.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">The task page</h3>
				<p class="text-base/7 sm:text-[14px]">
					Opening a task gives it a full page: a title and Markdown description you edit in place,
					a sidebar where you set status, priority, labels, and a target date — alongside the
					assignee, project, and branch the work is on — and an activity feed that interleaves
					comments with what actually happened: status changes, sessions started, a PR opened.
					Comment on the task yourself (pasted screenshots come along), or filter the feed down to
					comments only. Every session that has worked the task is listed, and a running one can
					be opened, split beside the page, or stopped from its row.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Local tickets or GitHub Issues</h3>
				<p class="text-base/7 sm:text-[14px]">
					Tasks are local and file-backed by default — no account, no sync, nothing leaves your
					machine. Point a project at GitHub instead and the board becomes that repository's
					issues: they read as tasks, edits are written back upstream, comments post as issue
					comments, and issues on a Projects v2 board carry their status, priority, and target
					date both ways. The choice is per project, so one repo can track issues upstream while
					another keeps a private list.
				</p>
				<p class="mt-5 text-[14px] text-[#A09488]">
					Agents have task tools too — they can read the board, create a task, move it through
					statuses, comment on it, and link it to a session, which is what keeps the board honest
					without you updating it by hand.
				</p>
			</section>

			<section id="rate-limits" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Rate Limit Queueing</h2>
				<p>
					Sooner or later a long session hits an API rate limit — usually mid-task. Solus handles
					it so you don't lose your work. Four behaviors are available, configurable globally in
					Settings or per-tab at any time:
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

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Knowing how much is left</h3>
				<p class="text-base/7 sm:text-[14px]">
					Better than handling a limit is seeing it coming. The project panel ({@render kbd('⌥M')})
					shows a meter for every signed-in agent: how much of the current
					<strong class="text-[#1A1714] font-medium">Session</strong> window and the
					<strong class="text-[#1A1714] font-medium">Weekly</strong> window is still available, with a
					countdown to when each one refills. The bar shifts colour as a window runs down, so a
					nearly-spent quota reads at a glance. Agents that don't report a quota are simply left out.
				</p>
			</section>

			<section id="connections" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Hosts & Connections</h2>
				<p>
					Solus isn't tied to one machine. The desktop app doubles as a server, so any browser on
					your network can pick up your sessions. And other machines running the Solus server —
					a home server, a spare Mac mini, a VPS — become <strong class="text-[#1A1714] font-medium">hosts</strong>:
					places you can open projects and run sessions, all driven from the same window.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">The web UI</h3>
				<p class="text-base/7 sm:text-[14px]">
					When Solus is running it listens on port <strong class="text-[#1A1714] font-medium">3000</strong> by default (override with the
					<code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">SOLUS_PORT</code> env var).
					The full web interface is served at that address — navigate to it from your phone, tablet,
					or another computer and you'll see the pairing screen on the first visit.
				</p>
				<div class="mt-4 p-4 rounded-xl border border-[rgba(0,0,0,0.07)] bg-[rgba(0,0,0,0.015)] font-mono text-[13px] text-[#6B6158]">
					http://&lt;your-mac-ip&gt;:3000 &nbsp;·&nbsp; e.g. http://192.168.1.42:3000
				</div>
				<p class="mt-3 text-[14px] text-[#A09488]">
					The exact addresses Solus is reachable from are listed in
					<strong class="text-[#A09488] font-medium">Settings → Connections</strong> — including localhost,
					LAN, and any Tailscale / VPN addresses.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Pairing a device</h3>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Generate a pair code', `In <strong class="text-[#1A1714] font-medium">Settings → Connections</strong>, click <strong class="text-[#1A1714] font-medium">Generate pair code</strong>. A 6-digit code appears alongside a set of pairing links — one per network interface the server is reachable from. <strong class="text-[#1A1714] font-medium">Codes expire after 5 minutes.</strong>`],
						['Connect from the browser', `Open a pairing link on the device (AirDrop, Messages, etc.) — the server address and one-time token are read from the URL automatically. Or switch to <strong class="text-[#1A1714] font-medium">Manual setup</strong> and enter the server address plus the 6-digit code.`],
						['Name the device', `Optionally set a device name — it defaults to your browser and OS (e.g. "Safari on macOS") and appears in the connected-devices list so you know what's connected.`],
						['Stay paired', 'After pairing, the browser holds a long-lived session token stored locally. Every later visit reconnects automatically — no re-pairing unless you revoke the device.'],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-4 text-[14px] text-[#A09488]">
					The web UI maintains a WebSocket connection and retries automatically if it drops — waking
					from sleep, switching networks, or a momentary blip all recover on their own. On supported
					browsers you can also enable web push notifications, so a run finishing or needing your
					attention reaches you even when the tab is in the background.
				</p>
				<p class="mt-3 text-[14px] text-[#A09488]">
					Links open on the device you're actually holding. Clicking a link in a session that runs on
					another host opens it in your own browser — the remote machine never opens a window you
					can't see.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Adding a host</h3>
				<p class="text-base/7 sm:text-[14px]">
					A host is any other machine running the Solus server. Add one from the host directory,
					and Solus walks it through setup so it's actually ready to work when you dispatch to it:
				</p>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['Pair over SSH', `Point Solus at <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">user@host</code> and it connects over SSH (asking for a password only if your keys don't cover it), installs the Solus server, and pairs it automatically. If SSH isn't an option, a fallback lets you enter the server's address and pair code by hand.`],
						['Claim a fresh server', `A server you installed yourself prints a claim link, code, and QR on <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus claim</code>. Opening the link takes ownership of the server; after that the normal device pairing flow applies.`],
						['Automatic setup', `Once paired, Solus runs the host's setup for you: it provisions your GitHub connection as git credentials on the host (served through <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus git-credential</code> and the <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">gh</code> CLI so clones, pushes, and PR creation work), installs the agent CLIs, and walks you through signing into them.`],
						['Readiness at a glance', `The host directory shows each host's readiness — what's installed, what's signed in, and what still needs attention — with one-click repairs for anything missing, like git identity.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Run on — choosing where a session runs</h3>
				<p class="text-base/7 sm:text-[14px]">
					Every new session has a <strong class="text-[#1A1714] font-medium">Run on</strong> picker in
					its header (and on the pill's status row). Before the session starts, choose any host —
					your own machine or a paired one. Solus remembers your choice per repository, so the next
					session in that repo defaults to the same host.
				</p>
				<p class="text-base/7 sm:text-[14px] mt-3">
					Sending a session to another host is called a <strong class="text-[#1A1714] font-medium">dispatch</strong>,
					and it carries the <em>repository</em>, not your working tree:
				</p>
				<ul class="mt-3 flex flex-col gap-3 list-none p-0">
					{#each [
						['A fresh checkout, every time', `The target host syncs its existing checkout or clones the repo from its git remote, then cuts a fresh worktree from the origin default branch. The code comes from the code host — not from your laptop.`],
						['Uncommitted changes stay put', `Local edits you haven't pushed don't travel. Dispatch is a fresh start on another machine, not a continuation of this one — if you want the work over there, commit and push first.`],
						['Always isolated', `A dispatched session always runs in its own worktree, because a shared checkout on a machine you aren't watching is a collision waiting to happen. Staying on your current host keeps the worktree toggle in your hands.`],
						['Work comes back as a PR', `Dispatched work returns the same way local work does: commit → push → pull request. There's no separate sync path to reason about.`],
						['Needs a git remote', `A project with no remote can't be dispatched — there's nothing to clone from. Open the folder directly on that host instead.`],
					] as [title, desc]}
						<li class="flex gap-3">
							<span class="mt-[9px] w-1 h-1 rounded-full bg-[#D4AF6A] shrink-0"></span>
							<span><strong class="text-[#1A1714] font-medium">{title}.</strong> {@html desc}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-4 text-[14px] text-[#A09488]">
					You can also open a project that already lives on a host: the open-project dialog lets you
					pick the destination host and browse (or clone into) its filesystem. A project opened this
					way behaves like a local one — worktree mode stays optional. Once a session has started,
					its host is fixed.
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

			<section id="settings" class="reveal py-10 border-b border-[rgba(0,0,0,0.06)]">
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
						['Default terminal', 'Terminal app used when opening a terminal or launching terminal-based editors. Supports the system default terminal and Ghostty. Terminals open as a window in a shared <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">solus</code> tmux session — created on first use — so every terminal Solus opens stays in one place and survives closing the window. This requires <code class="text-[12px] font-mono bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 rounded">tmux</code> on the machine running the session.'],
					] as [key, val], i}
						<div class="flex flex-col sm:flex-row gap-1 sm:gap-4 px-4 py-3 {i % 2 === 0 ? 'bg-[rgba(0,0,0,0.015)]' : ''} {i < 1 ? 'border-b border-[rgba(0,0,0,0.04)]' : ''}">
							<span class="text-base/6 sm:text-[13px] font-medium text-[#1A1714] sm:w-[148px] shrink-0">{key}</span>
							<span class="text-base/6 sm:text-[13px] text-[#6B6158]">{@html val}</span>
						</div>
					{/each}
				</div>

				<p class="mt-6 text-[14px] text-[#A09488]">Settings are persisted to disk and apply immediately — no restart required.</p>
			</section>

			<section id="keybindings" class="reveal py-10">
				<h2 class="text-[22px] sm:text-[20px] max-[1440px]:sm:text-[19px] font-semibold tracking-[-0.025em] text-[#1A1714] mb-4">Keybindings</h2>
				<p>
					The full reference. Solus is keyboard-first — every surface above has shortcuts, and the
					ones here are worth learning in roughly this order: summon, focus input, cycle modes,
					open the diff.
				</p>

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Global</h3>
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
					['⌘T', 'New session in the current task'],
					['⌘N', 'New task'],
					['⌘⇧N', 'New session without a task'],
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
					['⌘⇧F', 'Search in project'],
					['⌘E', 'Go to file'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Tasks</h3>
				{@render kbTable([
					['⌥⇧T', 'Open / close tasks'],
					['⌘N', 'New task'],
					['⌘T', 'New session in the current task'],
					['⌘⇧N', 'New session without a task'],
					['Esc', 'Clear selection / clear search / close'],
				])}

				<h3 class="text-[13px] font-semibold tracking-[0.05em] uppercase text-[#A09488] mb-1 mt-8">Project search</h3>
				<p class="text-base/7 sm:text-[14px]">These shortcuts are active while a search overlay is open.</p>
				{@render kbTable([
					['⌥C', 'Match case'],
					['⌥W', 'Match whole word'],
					['⌥R', 'Use a regular expression'],
					['⌘F', 'Find within the open file'],
					['Esc', 'Close'],
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

		</div>
	</main>
</div>
