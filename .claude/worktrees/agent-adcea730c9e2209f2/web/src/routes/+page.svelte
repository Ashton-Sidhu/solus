<script lang="ts">
	import { onMount } from "svelte";

	let mobileMenuOpen = $state(false);

	function downloadApp(e: MouseEvent) {
		e.preventDefault();
		const a = document.createElement("a");
		a.href = "/api/download";
		a.download = "Solus-latest-arm64.dmg";
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	function trackSpotlight(e: MouseEvent) {
		const card = e.currentTarget as HTMLElement;
		const rect = card.getBoundingClientRect();
		card.style.setProperty(
			"--mx",
			`${((e.clientX - rect.left) / rect.width) * 100}%`,
		);
		card.style.setProperty(
			"--my",
			`${((e.clientY - rect.top) / rect.height) * 100}%`,
		);
	}

	// === Hero auto-loop ===
	// One master phase machine drives all hero variants.
	type LoopPhase =
		| "rest"
		| "pill-arrive"
		| "pill-voice"
		| "pill-typing"
		| "pill-streaming"
		| "morph"
		| "editor-plan"
		| "plan-comment"
		| "plan-sent"
		| "editor-diff"
		| "diff-comment"
		| "diff-sent"
		| "editor-gallery"
		| "collapse";

	let loopPhase = $state<LoopPhase>("rest");
	let loopTyped = $state("");
	let loopStreamed = $state("");
	let loopTimers: ReturnType<typeof setTimeout>[] = [];

	const LOOP_USER_MSG = "Add error handling to UserService.ts";
	const LOOP_REPLY =
		"Drafted a plan — typed Result returns, named errors for missing users and expired tokens. Review when ready.";
	const LOOP_PLAN_COMMENT = "Use a discriminated union here, not a class.";
	const LOOP_DIFF_COMMENT = "Wrap this in a try/catch too — db can throw.";

	const loopPhaseLabel = $derived.by(() => {
		switch (loopPhase) {
			case "pill-arrive":
			case "pill-voice":
			case "pill-typing":
			case "pill-streaming":
				return "Pill mode";
			case "morph":
				return "Switching to editor mode";
			case "editor-plan":
				return "Plan view";
			case "plan-comment":
				return "Comment on plan";
			case "plan-sent":
				return "Sent to agent";
			case "editor-diff":
				return "Diff view";
			case "diff-comment":
				return "Comment on diff";
			case "diff-sent":
				return "Sent to agent";
			case "editor-gallery":
				return "Plan gallery";
			case "collapse":
				return "Dismiss";
			default:
				return "";
		}
	});

	function clearLoopTimers() {
		for (const id of loopTimers) clearTimeout(id);
		loopTimers = [];
	}

	function lSchedule(ms: number, fn: () => void) {
		loopTimers.push(setTimeout(fn, ms));
	}

	function loopTypeOut() {
		let i = 0;
		const tick = () => {
			if (loopPhase !== "pill-typing") return;
			i++;
			loopTyped = LOOP_USER_MSG.slice(0, i);
			if (i < LOOP_USER_MSG.length) {
				loopTimers.push(setTimeout(tick, 36));
			} else {
				lSchedule(360, () => {
					if (loopPhase !== "pill-typing") return;
					loopPhase = "pill-streaming";
					loopStreamPipe();
				});
			}
		};
		tick();
	}

	function loopStreamPipe() {
		loopStreamed = "";
		const tokens = LOOP_REPLY.split(/(\s+)/);
		let i = 0;
		const tick = () => {
			if (loopPhase !== "pill-streaming") return;
			if (i >= tokens.length) {
				queueEditorPhases();
				return;
			}
			loopStreamed += tokens[i];
			i++;
			loopTimers.push(setTimeout(tick, 30 + Math.random() * 34));
		};
		tick();
	}

	function queueEditorPhases() {
		// pill-streaming finishes → morph → plan → comment → sent → diff → diff comment → sent → gallery → collapse → loop
		let t = 700;
		lSchedule(t, () => {
			if (loopPhase === "pill-streaming") loopPhase = "morph";
		});
		// Morph holds for 1.6s — long enough for the window to grow + content to crossfade
		t += 1600;
		lSchedule(t, () => {
			loopPhase = "editor-plan";
		});
		t += 2200;
		lSchedule(t, () => {
			loopPhase = "plan-comment";
		});
		t += 2800;
		lSchedule(t, () => {
			loopPhase = "plan-sent";
		});
		t += 1400;
		lSchedule(t, () => {
			loopPhase = "editor-diff";
		});
		t += 2200;
		lSchedule(t, () => {
			loopPhase = "diff-comment";
		});
		t += 2800;
		lSchedule(t, () => {
			loopPhase = "diff-sent";
		});
		t += 1400;
		lSchedule(t, () => {
			loopPhase = "editor-gallery";
		});
		t += 3000;
		lSchedule(t, () => {
			loopPhase = "collapse";
		});
		t += 900;
		lSchedule(t, () => {
			loopPhase = "rest";
			loopTyped = "";
			loopStreamed = "";
		});
		t += 1200;
		lSchedule(t, () => runLoop());
	}

	function runLoop() {
		clearLoopTimers();
		loopPhase = "rest";
		loopTyped = "";
		loopStreamed = "";

		lSchedule(700, () => {
			if (loopPhase !== "rest") return;
			loopPhase = "pill-arrive";
		});
		lSchedule(1900, () => {
			if (loopPhase !== "pill-arrive") return;
			loopPhase = "pill-voice";
		});
		lSchedule(3300, () => {
			if (loopPhase !== "pill-voice") return;
			loopPhase = "pill-typing";
			loopTypeOut();
		});
	}

	onMount(() => {
		lSchedule(700, () => runLoop());

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						entry.target.classList.add("visible");
						observer.unobserve(entry.target);
					}
				}
			},
			{ threshold: 0.1 },
		);

		document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));

		return () => {
			clearLoopTimers();
			observer.disconnect();
		};
	});
</script>

<div class="grain" aria-hidden="true"></div>

<!-- Nav -->
<nav
	class="fixed top-5 max-[1400px]:top-8 inset-x-0 z-50 flex justify-center px-5 max-sm:px-4"
>
	<div
		class="flex items-center gap-8 max-sm:gap-3 px-5 max-sm:px-4 py-[11px] rounded-full w-full max-w-[640px]
	            bg-white/85 backdrop-blur-2xl
	            border border-black/[0.08]
	            shadow-[0_1px_0_rgba(0,0,0,0.05),0_4px_24px_rgba(0,0,0,0.08)]"
	>
		<a href="/" class="flex items-center gap-2 mr-auto no-underline">
			<svg
				width="20"
				height="20"
				viewBox="-60 -60 120 120"
				fill="none"
				aria-hidden="true"
			>
				<circle cx="0" cy="0" r="31.2" fill="#D4AF6A" />
				<g stroke="#D4AF6A" stroke-width="10.4" stroke-linecap="round">
					<path d="M 0,-52 A 52,52 0 0 1 52,0" />
					<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
					<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
				</g>
			</svg>
			<span
				class="font-[family-name:var(--font-display)] text-[15px] font-bold tracking-[-0.03em] text-[#1A1714]"
				>Solus</span
			>
		</a>

		<a
			href="#how-it-works"
			class="nav-link text-[13px] text-[#6B6158] hover:text-[#1A1714] transition-colors no-underline whitespace-nowrap max-sm:hidden"
		>
			How it works
		</a>
		<a
			href="#features"
			class="nav-link text-[13px] text-[#6B6158] hover:text-[#1A1714] transition-colors no-underline whitespace-nowrap max-sm:hidden"
		>
			Features
		</a>
		<a
			href="/docs"
			class="nav-link text-[13px] text-[#6B6158] hover:text-[#1A1714] transition-colors no-underline whitespace-nowrap max-sm:hidden"
		>
			Docs
		</a>

		<button
			onclick={downloadApp}
			class="ml-auto text-[12px] font-semibold text-white whitespace-nowrap cursor-pointer
		          px-3.5 py-1.5 rounded-full max-sm:hidden border-none
		          transition-[transform,box-shadow] duration-150
		          hover:-translate-y-px active:scale-[0.98]"
			style="background: linear-gradient(145deg, #e08868 0%, #d97757 40%, #c96442 100%); box-shadow: 0 2px 8px rgba(217,119,87,0.3);"
		>
			Download
		</button>

		<!-- Mobile hamburger -->
		<button
			class="sm:hidden relative flex items-center justify-center size-9 rounded-full
			       text-[#6B6158] hover:text-[#1A1714] transition-colors ml-auto"
			onclick={() => mobileMenuOpen = !mobileMenuOpen}
			aria-label="Toggle menu"
			aria-expanded={mobileMenuOpen}
		>
			<span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
			{#if mobileMenuOpen}
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			{:else}
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
			{/if}
		</button>
	</div>
</nav>

<!-- Mobile menu panel -->
{#if mobileMenuOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-40 sm:hidden"
		onkeydown={(e) => { if (e.key === 'Escape') mobileMenuOpen = false; }}
	>
		<div
			class="absolute inset-0 bg-black/20 backdrop-blur-sm"
			onclick={() => mobileMenuOpen = false}
			role="presentation"
		></div>
		<div
			class="absolute top-20 inset-x-4 flex flex-col gap-1 p-3
			       bg-white/95 backdrop-blur-2xl rounded-2xl
			       border border-black/[0.08]
			       shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
			style="animation: popup-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)"
		>
			<a
				href="#how-it-works"
				class="px-4 py-3 text-[15px] text-[#1A1714] no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => mobileMenuOpen = false}
			>How it works</a>
			<a
				href="#features"
				class="px-4 py-3 text-[15px] text-[#1A1714] no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => mobileMenuOpen = false}
			>Features</a>
			<a
				href="/docs"
				class="px-4 py-3 text-[15px] text-[#1A1714] no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => mobileMenuOpen = false}
			>Docs</a>
			<div class="h-px bg-black/[0.06] mx-2 my-1"></div>
			<button
				onclick={(e) => { mobileMenuOpen = false; downloadApp(e); }}
				class="mx-2 mb-1 px-4 py-3 text-[14px] font-semibold text-white text-center rounded-xl cursor-pointer border-none
				       transition-[transform,box-shadow] duration-150 active:scale-[0.98]"
				style="background: linear-gradient(145deg, #e08868 0%, #d97757 40%, #c96442 100%); box-shadow: 0 2px 8px rgba(217,119,87,0.3);"
			>Download</button>
		</div>
	</div>
{/if}

<!-- Hero -->
<section class="hero v2">
	<!-- Quiet title block -->
	<div class="v2-text">
		<h1 class="v2-title">
			The agent development environment <span class="v2-title-accent">that lives alongside your tools.</span>
		</h1>
		<p class="v2-sub">No new editor to adopt. Solus floats over your workflow — review plans, comment on diffs, and talk to your agent in pill or editor mode.</p>
		<div class="v2-cta-row">
			<button onclick={downloadApp} class="v2-cta-primary">
				<svg
					width="14"
					height="14"
					viewBox="0 0 814 1000"
					fill="currentColor"
					aria-hidden="true"
				>
					<path
						d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.3-165-39.3c-76.5 0-103.7 40.8-165 40.8s-105-42.7-147.8-103.6c-49-68.9-90.6-176.5-90.6-279C0 469.8 166.4 265 348.6 265 407.5 265 458 304.5 490 304.5c29.8 0 88.8-44.5 163.7-44.5 26.6 0 108.2 2.6 168.6 74.9zm-237.6-74.9c31.8-37.7 54.6-90.1 54.6-142.5 0-7.1-.6-14.3-1.9-20.1-51.9 2-112.3 34.8-149.1 75.5-29.2 32.6-55.1 84.4-55.1 139.8 0 7.7 1.3 15.5 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 46.5 0 102.3-31.2 136-72.1z"
					/>
				</svg>
				Download for macOS
			</button>
			<span class="v2-meta">Free during beta · macOS 13+</span>
		</div>
		<ul class="v2-trust" aria-label="What Solus is">
			<li>Keyboard-first</li>
			<li>Model-agnostic — Claude Code &amp; Codex</li>
			<li>No new tools to adopt</li>
		</ul>
	</div>

	<!-- Cinematic scene -->
	<div class="v2-scene-wrapper">
		<div class="v2-scene">
			<img
				src="/hero-wallpaper.jpg"
				alt=""
				class="v2-wallpaper-img"
				loading="eager"
				decoding="async"
			/>
			<div class="v2-grain" aria-hidden="true"></div>

			<!-- ── Desktop chrome: the real workspace Solus floats over.
			     Static + aria-hidden; not part of the morph loop. ── -->

			<!-- Menu bar (top, above Solus like real system chrome) -->
			<div class="v2-menubar" aria-hidden="true">
				<div class="v2-menubar-left">
					<span class="v2-menubar-logo">
						<svg width="12" height="13" viewBox="0 0 24 24" fill="currentColor"
							><path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" /></svg
						>
					</span>
					<span class="v2-menubar-app">vim</span>
					<span class="v2-menubar-menu">File</span>
					<span class="v2-menubar-menu">Edit</span>
					<span class="v2-menubar-menu">View</span>
				</div>
				<div class="v2-menubar-right">
					<!-- Solus lives in the menu-bar tray, not the dock (active = panel open) -->
					<span class="v2-menubar-solus" data-active="true">
						<svg width="14" height="14" viewBox="-60 -60 120 120" fill="none"
							><circle cx="0" cy="0" r="31.2" fill="#D4AF6A" /><g
								stroke="#D4AF6A"
								stroke-width="10.4"
								stroke-linecap="round"
								><path d="M 0,-52 A 52,52 0 0 1 52,0" /><path
									d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92"
								/><path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" /></g
							></svg
						>
					</span>
					<span class="v2-menubar-glyph">
						<svg width="24" height="13" viewBox="0 0 26 14" fill="none"
							stroke="currentColor" stroke-width="1.3"
							><rect x="1" y="1.5" width="20" height="11" rx="2.6" /><rect
								x="3"
								y="3.5"
								width="13"
								height="7"
								rx="1.2"
								fill="currentColor"
								stroke="none"
							/><path d="M23.5 5v4" stroke-width="2" stroke-linecap="round" /></svg
						>
					</span>
					<span class="v2-menubar-glyph">
						<svg width="15" height="12" viewBox="0 0 24 18" fill="none"
							stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
							><path d="M2 5.5a15 15 0 0 1 20 0" /><path
								d="M5.5 9.5a10 10 0 0 1 13 0"
							/><path d="M9 13.5a5 5 0 0 1 6 0" /><circle
								cx="12"
								cy="16.5"
								r="0.6"
								fill="currentColor"
							/></svg
						>
					</span>
					<span class="v2-menubar-glyph">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
							stroke="currentColor" stroke-width="2"
							><circle cx="11" cy="11" r="7" /><line
								x1="21"
								y1="21"
								x2="16.5"
								y2="16.5"
							/></svg
						>
					</span>
					<span class="v2-menubar-clock">9:41</span>
				</div>
			</div>

			<!-- Terminal running vim — the file Solus is about to edit -->
			<div class="v2-terminal" aria-hidden="true">
				<div class="v2-terminal-bar">
					<div class="v2-traffic-lights" aria-hidden="true">
						<span class="v2-dot close"></span>
						<span class="v2-dot minimize"></span>
						<span class="v2-dot maximize"></span>
					</div>
					<span class="v2-terminal-title">UserService.ts — vim</span>
				</div>
				<div class="v2-terminal-body">
					<div class="v2-terminal-code">
						<div class="v2-cl"><span class="ln">1</span><span class="code"
								><span class="kw">import</span> &lbrace; db &rbrace; <span class="kw"
									>from</span
								> <span class="str">"../db"</span>;</span
							></div>
						<div class="v2-cl"><span class="ln">2</span><span class="code"></span></div>
						<div class="v2-cl"><span class="ln">3</span><span class="code"
								><span class="kw">export</span> <span class="kw">class</span>
								<span class="ty">UserService</span> &lbrace;</span
							></div>
						<div class="v2-cl"><span class="ln">4</span><span class="code"
								>  <span class="kw">async</span> <span class="fn">getUser</span>(id:
								<span class="ty">string</span>) &lbrace;</span
							></div>
						<div class="v2-cl"><span class="ln">5</span><span class="code"
								>    <span class="kw">const</span> u = <span class="kw">await</span>
								db.<span class="fn">find</span>(id);</span
							></div>
						<div class="v2-cl"><span class="ln">6</span><span class="code"
								>    <span class="kw">if</span> (!u) <span class="v2-vim-cursor"
									>t</span
								><span class="kw">hrow</span> <span class="kw">new</span>
								<span class="ty">Error</span>(<span class="str">"not found"</span
								>);</span
							></div>
						<div class="v2-cl"><span class="ln">7</span><span class="code"
								>    <span class="kw">return</span> u;</span
							></div>
						<div class="v2-cl"><span class="ln">8</span><span class="code"
								>  &rbrace;</span
							></div>
						<div class="v2-cl v2-cl-extra"><span class="ln">9</span><span class="code"
							></span></div>
						<div class="v2-cl v2-cl-extra"><span class="ln">10</span><span class="code"
								>  <span class="kw">async</span> <span class="fn">refreshToken</span
								>(token: <span class="ty">string</span>) &lbrace;</span
							></div>
						<div class="v2-cl v2-cl-extra"><span class="ln">11</span><span class="code"
								>    <span class="kw">const</span> t = <span class="kw">await</span>
								db.tokens.<span class="fn">get</span>(token);</span
							></div>
						<div class="v2-cl v2-cl-extra"><span class="ln">12</span><span class="code"
								>    <span class="kw">return</span> t.value;</span
							></div>
						<div class="v2-cl v2-cl-extra"><span class="ln">13</span><span class="code"
								>  &rbrace;</span
							></div>
						<div class="v2-cl"><span class="ln">14</span><span class="code"
								>&rbrace;</span
							></div>
					</div>
				</div>
				<div class="v2-terminal-status">
					<span class="v2-vim-mode">NORMAL</span>
					<span class="v2-vim-file">UserService.ts</span>
					<span class="v2-vim-spacer"></span>
					<span class="v2-vim-meta">utf-8 ts</span>
					<span class="v2-vim-pos">6:13</span>
				</div>
			</div>

			<!-- Dock (bottom, glassy; above Solus like real system chrome) -->
			<div class="v2-dock" aria-hidden="true">
				<div class="v2-dock-tile finder">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
						stroke="rgba(255,255,255,0.95)" stroke-width="1.8"
						><rect x="3" y="4" width="18" height="16" rx="2.5" /><line
							x1="11"
							y1="4"
							x2="11"
							y2="20"
						/></svg
					>
				</div>
				<div class="v2-dock-tile terminal">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
						stroke="#e6ddc9" stroke-width="2" stroke-linecap="round"
						stroke-linejoin="round"
						><polyline points="5 8 9 12 5 16" /><line
							x1="11"
							y1="16"
							x2="16"
							y2="16"
						/></svg
					>
				</div>
				<div class="v2-dock-tile browser">
					<svg width="19" height="19" viewBox="0 0 24 24" fill="none"
						stroke="rgba(255,255,255,0.95)" stroke-width="1.7"
						><circle cx="12" cy="12" r="9" /><polygon
							points="15.5 8.5 13 13 8.5 15.5 11 11"
							fill="rgba(255,255,255,0.95)"
							stroke="none"
						/></svg
					>
				</div>
			</div>

			<!-- Morphing window -->
			<div class="v2-window" data-phase={loopPhase}>
				<!-- Drag bar — collapses to 0 height in pill phases via CSS -->
				<div class="solus-drag-bar" aria-hidden="true">
					<div class="v2-traffic-lights" aria-hidden="true">
						<span class="v2-dot close"></span>
						<span class="v2-dot minimize"></span>
						<span class="v2-dot maximize"></span>
					</div>
				</div>

			<div class="v2-content-area">
				<!-- ── PILL CONTENT ── -->
				<div
					class="v2-pill-content"
					data-active={[
						"rest",
						"pill-arrive",
						"pill-voice",
						"pill-typing",
						"pill-streaming",
						"collapse",
					].includes(loopPhase)
						? "true"
						: "false"}
				>
					<!-- Streaming conversation — floats above input like the real app -->
					{#if loopPhase === "pill-streaming"}
						<div class="solus-conv-float">
							<div class="solus-conv-user">{LOOP_USER_MSG}</div>
							<p class="solus-conv-asst">
								{loopStreamed}<span class="solus-cursor" aria-hidden="true"
									>▊</span
								>
							</p>
						</div>
					{/if}

					<div
						class="solus-input-pill"
						style="display:flex;flex-direction:column;"
					>
						<!-- Tabstrip — matches TabStrip.svelte -->
						<div class="solus-tabstrip">
							<div class="solus-tabs">
								<div class="solus-tab active">
									<span
										class="solus-tab-dot"
										data-state={loopPhase === "pill-streaming"
											? "running"
											: "idle"}
									></span>
									<span class="solus-tab-label">Add error handling</span>
									<svg
										class="solus-tab-folder"
										width="9"
										height="9"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										aria-hidden="true"
										><path
											d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
										/></svg
									>
									<span class="solus-tab-branch">api</span>
								</div>
								<div class="solus-tab">
									<span class="solus-tab-dot"></span>
									<span class="solus-tab-label">auth</span>
									<svg
										class="solus-tab-folder"
										width="9"
										height="9"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										aria-hidden="true"
										><path
											d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
										/></svg
									>
									<span class="solus-tab-branch">web</span>
								</div>
							</div>
							<div class="solus-tabs-sep" aria-hidden="true"></div>
							<div class="solus-tabs-actions">
								<span class="solus-icon-sm" aria-hidden="true">
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"><path d="M12 5v14M5 12h14" /></svg
									>
								</span>
								<span class="solus-icon-sm" aria-hidden="true">
									<svg
										width="13"
										height="13"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										><circle cx="12" cy="12" r="10" /><path
											d="M12 6v6l4 2"
										/></svg
									>
								</span>
								<span class="solus-icon-sm" aria-hidden="true">
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										><path
											d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
										/><polyline points="14 2 14 8 20 8" /></svg
									>
								</span>
							</div>
						</div>

						<!-- Action row -->
						<div class="solus-action-row" style="flex:none;">
							<div class="solus-action-btns">
								<span class="solus-icon" aria-hidden="true">
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										><path
											d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
										/></svg
									>
								</span>
								<span class="solus-icon" aria-hidden="true">
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										><path
											d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
										/><circle cx="12" cy="13" r="4" /></svg
									>
								</span>
								<span class="solus-icon" aria-hidden="true">
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										><path d="M12 20h9" /><path
											d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
										/></svg
									>
								</span>
							</div>
							<div class="solus-vline" aria-hidden="true"></div>
							<div class="solus-input">
								{#if loopPhase === "pill-voice"}
									<span class="solus-listening" role="status">
										<span class="wave" aria-hidden="true"></span>
										<span class="wave" aria-hidden="true"></span>
										<span class="wave" aria-hidden="true"></span>
										<span class="wave" aria-hidden="true"></span>
										Listening…
									</span>
								{:else if loopPhase === "pill-typing"}
									<span>{loopTyped}</span>
									<span class="solus-input-cursor" aria-hidden="true"></span>
								{:else}
									<span class="solus-input-placeholder">Ask anything…</span>
								{/if}
							</div>
							<div class="solus-send-group">
								<span
									class="solus-mic"
									class:active={loopPhase === "pill-voice"}
									aria-hidden="true"
								>
									<svg
										width="12"
										height="12"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
									>
										<path
											d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"
										/>
										<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
										<path d="M12 19v3" />
										<path d="M9 22c1 .5 3 .5 6 0" />
									</svg>
								</span>
								<span
									class="solus-send"
									class:armed={loopPhase === "pill-typing"}
									aria-hidden="true"
								>
									<svg
										width="12"
										height="12"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
									>
										<line x1="22" y1="2" x2="11" y2="13" />
										<polygon points="22 2 15 22 11 13 2 9 22 2" />
									</svg>
								</span>
							</div>
						</div>

						<!-- Status bar -->
						<div class="solus-statusbar pill">
							<span class="solus-statusbar-item">
								<svg
									width="11"
									height="11"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									aria-hidden="true"
									><path
										d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
									/></svg
								>
								~/projects/api
							</span>
							<span class="solus-statusbar-sep">|</span>
							<span class="solus-statusbar-item">
								<svg
									width="10"
									height="10"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									aria-hidden="true"
									><path d="M6 3v12a3 3 0 0 0 3 3h6" /><path
										d="M18 9a3 3 0 0 0-3-3H9"
									/></svg
								>
								main
							</span>
							<span class="solus-statusbar-sep">|</span>
							<span class="solus-statusbar-picker">Opus 4.6</span>
							<span class="solus-statusbar-sep">|</span>
							<span class="solus-statusbar-picker">Plan mode</span>
							<span class="solus-statusbar-spacer"></span>
							<span class="solus-statusbar-picker">Claude Code</span>
							<span class="solus-statusbar-settings" aria-hidden="true">
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									><circle cx="12" cy="12" r="3" /><path
										d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
									/></svg
								>
							</span>
						</div>
					</div>
				</div>

				<!-- ── EDITOR CONTENT ── -->
				<div
					class="v2-editor-content"
					data-active={[
						"morph",
						"editor-plan",
						"plan-comment",
						"plan-sent",
						"editor-diff",
						"diff-comment",
						"diff-sent",
						"editor-gallery",
					].includes(loopPhase)
						? "true"
						: "false"}
				>
					<div class="v2-editor-body">
						<!-- Sessions sidebar — matches SessionSidebar.svelte -->
						<div class="solus-sidebar compact">
							<div class="solus-sidebar-head">
								Sessions
								<div class="solus-sidebar-actions">
									<span class="solus-icon-sm" aria-hidden="true">
										<svg
											width="13"
											height="13"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											><circle cx="12" cy="12" r="10" /><path
												d="M12 6v6l4 2"
											/></svg
										>
									</span>
									<span class="solus-icon-sm" aria-hidden="true">
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											><path
												d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
											/><polyline points="14 2 14 8 20 8" /></svg
										>
									</span>
									<span class="solus-icon-sm" aria-hidden="true">
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"><path d="M12 5v14M5 12h14" /></svg
										>
									</span>
								</div>
							</div>
							<ul class="solus-session-list">
								<li class="solus-session active">
									<div class="solus-session-row">
										<span
											class="solus-provider-badge claude"
											aria-hidden="true"
										>
											<svg
												width="11"
												height="11"
												viewBox="0 0 24 24"
												fill="currentColor"
												><path
													d="M17.32 9.02a1.5 1.5 0 0 0-1.78-.6l-2.58.86a.5.5 0 0 1-.32 0L10.06 8.4a1.5 1.5 0 0 0-1.77.6L6.8 11.45a1.5 1.5 0 0 0 .25 1.87l1.93 1.72a.5.5 0 0 1 .15.28l.45 2.68a1.5 1.5 0 0 0 1.52 1.24h1.8a1.5 1.5 0 0 0 1.52-1.24l.45-2.68a.5.5 0 0 1 .15-.28l1.93-1.72a1.5 1.5 0 0 0 .25-1.87l-1.48-2.44z"
												/></svg
											>
										</span>
										<div class="solus-session-title">
											Add error handling to UserService.ts
										</div>
									</div>
									<div class="solus-session-byline">
										<span>~/projects/api</span>
										<svg
											width="10"
											height="10"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											aria-hidden="true"
											><path d="M6 3v12a3 3 0 0 0 3 3h6" /><path
												d="M18 9a3 3 0 0 0-3-3H9"
											/></svg
										>
										<span>main</span>
									</div>
								</li>
								<li class="solus-session">
									<div class="solus-session-row">
										<span
											class="solus-provider-badge claude"
											aria-hidden="true"
										>
											<svg
												width="11"
												height="11"
												viewBox="0 0 24 24"
												fill="currentColor"
												><path
													d="M17.32 9.02a1.5 1.5 0 0 0-1.78-.6l-2.58.86a.5.5 0 0 1-.32 0L10.06 8.4a1.5 1.5 0 0 0-1.77.6L6.8 11.45a1.5 1.5 0 0 0 .25 1.87l1.93 1.72a.5.5 0 0 1 .15.28l.45 2.68a1.5 1.5 0 0 0 1.52 1.24h1.8a1.5 1.5 0 0 0 1.52-1.24l.45-2.68a.5.5 0 0 1 .15-.28l1.93-1.72a1.5 1.5 0 0 0 .25-1.87l-1.48-2.44z"
												/></svg
											>
										</span>
										<div class="solus-session-title">
											Wire telemetry into handlers
										</div>
									</div>
									<div class="solus-session-byline">
										<span>~/projects/api</span>
										<svg
											width="10"
											height="10"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											aria-hidden="true"
											><path d="M6 3v12a3 3 0 0 0 3 3h6" /><path
												d="M18 9a3 3 0 0 0-3-3H9"
											/></svg
										>
										<span>feat/telemetry</span>
									</div>
								</li>
							</ul>
						</div>

						<!-- Main view column -->
						<div class="v2-main">
							<!-- Plan view: morph / editor-plan / plan-comment / plan-sent -->
							{#if ["morph", "editor-plan", "plan-comment", "plan-sent"].includes(loopPhase)}
								<div class="solus-plan" style="position:relative;">
									<div class="solus-plan-head">
										<div class="solus-plan-title">
											Plan
											<span class="solus-plan-version">v1</span>
										</div>
										<div class="solus-plan-actions">
											<button
												class="solus-plan-btn solus-plan-btn-comments"
												data-active={["plan-comment", "plan-sent"].includes(
													loopPhase,
												)
													? "true"
													: "false"}
											>
												<svg
													width="10"
													height="10"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													><path
														d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
													/></svg
												>
												{#if ["plan-comment", "plan-sent"].includes(loopPhase)}
													<span class="solus-plan-btn-count">1</span>
												{/if}
											</button>
											<button class="solus-plan-btn solus-plan-btn-ghost"
												>Reject <span class="solus-kbd-hint">⌥R</span></button
											>
											<button class="solus-plan-btn solus-plan-btn-accent-soft">
												<svg
													width="11"
													height="11"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2.5"
													><polyline points="20 6 9 17 4 12" /></svg
												>
												Yes (auto) <span class="solus-kbd-hint">⌥A</span>
											</button>
											<button class="solus-plan-btn solus-plan-btn-primary">
												<svg
													width="11"
													height="11"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2.5"
													><polyline points="20 6 9 17 4 12" /></svg
												>
												Yes <span class="solus-kbd-hint">⌥Y</span>
											</button>
										</div>
									</div>
									<div
										class="solus-plan-shell"
										data-rail-open={["plan-comment", "plan-sent"].includes(
											loopPhase,
										)
											? "true"
											: "false"}
									>
										<div class="solus-plan-toc">
											<div class="solus-plan-toc-label">Contents</div>
											<ul>
												<li><span class="active">1. Result types</span></li>
												<li><span>2. Named errors</span></li>
												<li><span>3. Service update</span></li>
											</ul>
										</div>
										<div class="solus-plan-content">
											<h1>Typed Result returns for UserService</h1>
											<h2>1. Result types</h2>
											<p>
												Replace all
												<code
													data-selected={["plan-comment", "plan-sent"].includes(
														loopPhase,
													)
														? "true"
														: "false"}>try/catch</code
												>
												blocks with a discriminated union
												<code>Result&lt;T, E&gt;</code>. Prevents uncaught
												exceptions propagating to callers.
											</p>
											<h2>2. Named errors</h2>
											<p>
												Introduce <code>UserNotFoundError</code> and
												<code>TokenExpiredError</code> extending a base
												<code>AppError</code>.
											</p>
											<h2>3. Service update</h2>
											<p>
												Update <code>UserService.getUser</code> and
												<code>UserService.refreshToken</code> to return
												<code>Result</code>.
											</p>
										</div>
										{#if ["plan-comment", "plan-sent"].includes(loopPhase)}
											<div class="solus-comments-rail">
												<div class="solus-comments-rail-head">
													<svg
														width="11"
														height="11"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														stroke-width="2"
														><path
															d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
														/></svg
													>
													Comments
													<span class="solus-comments-rail-count">1</span>
												</div>
												<div class="solus-comments-rail-body">
													<div class="solus-comment-card active">
														<div class="solus-comment-card-head">
															<span class="solus-comment-card-avatar"
																>A</span
															>
															<span class="solus-comment-card-author"
																>You</span
															>
														</div>
														<div class="solus-comment-card-quote">
															try/catch
														</div>
														<p class="solus-comment-card-body">
															{LOOP_PLAN_COMMENT}
														</p>
														<div class="solus-comment-card-actions">
															<button class="solus-comment-send-btn">
																<svg
																	width="10"
																	height="10"
																	viewBox="0 0 24 24"
																	fill="none"
																	stroke="currentColor"
																	stroke-width="2"
																>
																	<line x1="22" y1="2" x2="11" y2="13" />
																	<polygon points="22 2 15 22 11 13 2 9 22 2" />
																</svg>
																Send to agent
															</button>
														</div>
													</div>
												</div>
											</div>
										{/if}
									</div>
									{#if loopPhase === "plan-sent"}
										<div class="solus-sent-chip plan-sent">
											<svg
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2.5"
												><polyline points="20 6 9 17 4 12" /></svg
											>
											Comment sent to agent
										</div>
									{/if}
								</div>
							{/if}

							<!-- Diff view: editor-diff / diff-comment / diff-sent -->
							{#if ["editor-diff", "diff-comment", "diff-sent"].includes(loopPhase)}
								<div class="solus-diff">
									<!-- Diff toolbar — matches DiffToolbar.svelte -->
									<div class="solus-diff-toolbar">
										<svg
											width="10"
											height="10"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2.5"
											style="color:#8a8a80;flex-shrink:0"
											aria-hidden="true"
											><path d="M6 3v12a3 3 0 0 0 3 3h6" /><path
												d="M18 9a3 3 0 0 0-3-3H9"
											/></svg
										>
										<span class="solus-diff-branch">feat/error-handling</span>
										<span class="solus-diff-branch-arrow">→</span>
										<span class="solus-diff-branch-target">main</span>
										<div class="solus-diff-stats">
											<span class="add">2 files</span>
											<span class="add">+12</span>
											<span class="del">−4</span>
										</div>
										<div class="solus-diff-toolbar-spacer"></div>
										<button class="solus-diff-files-btn">
											<svg
												width="11"
												height="11"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2.5"
												aria-hidden="true"
												><rect x="3" y="3" width="7" height="7" rx="1" /><rect
													x="14"
													y="3"
													width="7"
													height="7"
													rx="1"
												/><rect x="3" y="14" width="7" height="7" rx="1" /><rect
													x="14"
													y="14"
													width="7"
													height="7"
													rx="1"
												/></svg
											>
											2
										</button>
										<div class="solus-diff-toggle">
											<button class="diff-toggle-btn">Unified</button>
											<button class="diff-toggle-btn active">Split</button>
										</div>
										<button
											class="solus-diff-comments-btn"
											data-active={["diff-comment", "diff-sent"].includes(
												loopPhase,
											)
												? "true"
												: "false"}
										>
											<svg
												width="10"
												height="10"
												viewBox="0 0 24 24"
												fill="currentColor"
												stroke="none"
												><path
													d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
												/></svg
											>
											1
										</button>
										<button class="solus-diff-ghost-btn" aria-hidden="true">
											<svg
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												><rect x="2" y="4" width="20" height="16" rx="2" /><path
													d="M6 8h.01M10 8h.01M14 8h.01"
												/></svg
											>
										</button>
										<button class="solus-diff-ghost-btn" aria-hidden="true">
											<svg
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												><polyline points="15 3 21 3 21 9" /><polyline
													points="9 21 3 21 3 15"
												/><line x1="21" y1="3" x2="14" y2="10" /><line
													x1="3"
													y1="21"
													x2="10"
													y2="14"
												/></svg
											>
										</button>
										<button class="solus-diff-ghost-btn" aria-hidden="true">
											<svg
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												><line x1="18" y1="6" x2="6" y2="18" /><line
													x1="6"
													y1="6"
													x2="18"
													y2="18"
												/></svg
											>
										</button>
									</div>

									<!-- Diff layout: tree sidebar + split diff -->
									<div class="solus-diff-layout">
										<!-- File tree sidebar -->
										<div class="solus-diff-tree">
											<div class="solus-diff-tree-head">Files</div>
											<div class="solus-diff-tree-list">
												<div class="solus-diff-tree-folder" data-level="0">src</div>
												<div class="solus-diff-tree-folder" data-level="1">services</div>
												<button class="solus-diff-tree-file active" data-level="2">
													UserService.ts
													<span class="solus-diff-tree-badge modified">M</span>
												</button>
												<div class="solus-diff-tree-folder" data-level="1">types</div>
												<button class="solus-diff-tree-file" data-level="2">
													errors.ts
													<span class="solus-diff-tree-badge added">A</span>
												</button>
											</div>
										</div>

										<!-- Split diff stream -->
										<div class="solus-diff-stream">
											<div class="solus-diff-file-header">
												<span class="diff-file-icon ts">TS</span>
												src/services/UserService.ts
												<span class="diff-file-stats" style="margin-left:auto"><span class="add">+12</span> <span class="del">−4</span></span>
											</div>
											<div class="solus-diff-split">
												<div class="solus-diff-split-hunk">
													<span>@@ -17,8 +17,14 @@ async getUser</span>
													<span class="gutter"></span>
													<span></span>
												</div>
												<div class="solus-diff-split-row">
													<span class="num">17</span>
													<span class="code">async getUser(id: string) &lbrace;</span>
													<span class="gutter"></span>
													<span class="num">17</span>
													<span class="code">async getUser(id: string) &lbrace;</span>
												</div>
												<div class="solus-diff-split-row">
													<span class="num del">18</span>
													<span class="code del"> const u = await db.find(id);</span>
													<span class="gutter"></span>
													<span class="num add">18</span>
													<span class="code add"> const u = await db.users.find(id);</span>
												</div>
												<div
													class="solus-diff-split-row"
													data-commenting={loopPhase === "diff-comment"
														? "true"
														: "false"}
													data-commented={loopPhase === "diff-sent"
														? "true"
														: "false"}
												>
													<span class="num del">19</span>
													<span class="code del"> if (!u) throw new Error('not found');</span>
													<span class="gutter"></span>
													<span class="num add">19</span>
													<span class="code add"> if (!u) return err(new UserNotFoundError(id));</span>
													{#if ["diff-comment", "diff-sent"].includes(loopPhase)}
														<span class="solus-diff-comment-anchor">
															<svg
																width="8"
																height="8"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																stroke-width="2.5"
																><path
																	d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
																/></svg
															>
														</span>
													{/if}
												</div>
												<div class="solus-diff-split-row">
													<span class="num"></span>
													<span class="code empty"></span>
													<span class="gutter"></span>
													<span class="num add">20</span>
													<span class="code add"> if (u.deletedAt) return err(new UserDeletedError(id));</span>
												</div>
												<div class="solus-diff-split-row">
													<span class="num">21</span>
													<span class="code"> return ok(u);</span>
													<span class="gutter"></span>
													<span class="num">21</span>
													<span class="code"> return ok(u);</span>
												</div>
												<div class="solus-diff-split-row">
													<span class="num">22</span>
													<span class="code">&rbrace;</span>
													<span class="gutter"></span>
													<span class="num">22</span>
													<span class="code">&rbrace;</span>
												</div>
											</div>
										</div>
									</div>

									<!-- Comment popover -->
									{#if loopPhase === "diff-comment"}
										<div class="solus-diff-comment-popover compact">
											<div class="solus-diff-comment-popover-head">
												<svg
													width="11"
													height="11"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													><path
														d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
													/></svg
												>
												<span class="solus-diff-comment-loc"
													>UserService.ts</span
												>
												<span class="solus-diff-comment-line">L19</span>
												<span class="solus-diff-comment-popover-spacer"></span>
												<button
													class="solus-diff-comment-popover-close"
													aria-label="Close comment">✕</button
												>
											</div>
											<div class="solus-diff-comment-popover-quote">
												<span class="quote-mark">+</span>
												<code
													>if (!u) return err(new UserNotFoundError(id));</code
												>
											</div>
											<div class="solus-diff-comment-popover-body">
												<p>{LOOP_DIFF_COMMENT}</p>
											</div>
											<div class="solus-diff-comment-popover-actions">
												<button class="solus-comment-cancel">Cancel</button>
												<button class="solus-comment-send-btn">
													<svg
														width="10"
														height="10"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														stroke-width="2"
													>
														<line x1="22" y1="2" x2="11" y2="13" />
														<polygon points="22 2 15 22 11 13 2 9 22 2" />
													</svg>
													Send to agent
												</button>
											</div>
										</div>
									{/if}

									{#if loopPhase === "diff-sent"}
										<div class="solus-sent-chip">
											<svg
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2.5"
												><polyline points="20 6 9 17 4 12" /></svg
											>
											Comment sent to agent
										</div>
									{/if}
								</div>
							{/if}

							<!-- Gallery view: editor-gallery — matches PlanGallery.svelte -->
							{#if loopPhase === "editor-gallery"}
								<div class="solus-gallery compact">
									<div class="solus-gallery-top">
										<div class="solus-gallery-head">
											<span class="solus-gallery-title">Plans</span>
											<button
												class="solus-gallery-close-btn"
												aria-hidden="true"
											>
												<svg
													width="16"
													height="16"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													><line x1="18" y1="6" x2="6" y2="18" /><line
														x1="6"
														y1="6"
														x2="18"
														y2="18"
													/></svg
												>
											</button>
										</div>
										<div class="solus-gallery-search">
											<svg
												width="15"
												height="15"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												style="color:#8a8a80;flex-shrink:0"
												aria-hidden="true"
												><circle cx="11" cy="11" r="8" /><line
													x1="21"
													y1="21"
													x2="16.65"
													y2="16.65"
												/></svg
											>
											<span class="solus-gallery-search-placeholder"
												>Search plans…</span
											>
											<span class="solus-gallery-scope-chip"
												>api <svg
													width="10"
													height="10"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													><polyline points="6 9 12 15 18 9" /></svg
												></span
											>
											<kbd class="solus-gallery-kbd">ESC</kbd>
										</div>
										<div class="solus-gallery-tabs">
											<button class="solus-gallery-tab">
												All
												<span class="count">4</span>
											</button>
											<button class="solus-gallery-tab active">
												<span class="dot pending"></span>
												Pending
												<span class="count">1</span>
											</button>
											<button class="solus-gallery-tab">
												<span class="dot accepted">✓</span>
												Accepted
												<span class="count">2</span>
											</button>
											<button class="solus-gallery-tab">
												<span class="dot rejected">✗</span>
												Rejected
												<span class="count">1</span>
											</button>
											<span class="solus-gallery-filters-spacer"></span>
											<button class="solus-gallery-bookmark-chip">
												<svg
													width="11"
													height="11"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													><path
														d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
													/></svg
												>
												Bookmarked
											</button>
										</div>
									</div>
									<div class="solus-gallery-grid">
										<div class="solus-plan-card pending bookmarked">
											<div class="solus-plan-card-accent"></div>
											<div class="solus-plan-card-body">
												<div class="solus-plan-card-header">
													<div class="solus-plan-card-meta">
														<span
															class="solus-plan-card-provider claude"
															aria-hidden="true"
														>
															<svg
																width="10"
																height="10"
																viewBox="0 0 24 24"
																fill="currentColor"
																><path
																	d="M15.4 8.6 12 2 8.6 8.6 2 12l6.6 3.4L12 22l3.4-6.6L22 12l-6.6-3.4Z"
																/></svg
															>
														</span>
														<span class="meta-text">api</span>
														<span class="meta-sep">/</span>
														<span class="meta-text">2m ago</span>
														<span class="revision-pip">v3</span>
														<span class="comment-pip">
															<svg
																width="9"
																height="9"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																aria-hidden="true"
																><path
																	d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
																/></svg
															>
															2
														</span>
													</div>
													<div class="solus-plan-card-actions">
														<button
															class="solus-card-icon-btn"
															aria-hidden="true"
														>
															<svg
																width="11"
																height="11"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																><path d="M7 17 17 7" /><path
																	d="M7 7h10v10"
																/></svg
															>
														</button>
														<button
															class="solus-card-icon-btn is-active always-show"
															aria-hidden="true"
														>
															<svg
																width="11"
																height="11"
																viewBox="0 0 24 24"
																fill="currentColor"
																><path
																	d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
																/></svg
															>
														</button>
													</div>
												</div>
												<div class="solus-plan-card-title">
													Typed Result returns for UserService
												</div>
												<div class="solus-plan-card-excerpt">
													Replace try/catch with Result&lt;T,E&gt; discriminated
													union.
												</div>
											</div>
										</div>
										<div class="solus-plan-card accepted">
											<div class="solus-plan-card-accent"></div>
											<div class="solus-plan-card-body">
												<div class="solus-plan-card-header">
													<div class="solus-plan-card-meta">
														<span
															class="solus-plan-card-provider claude"
															aria-hidden="true"
														>
															<svg
																width="10"
																height="10"
																viewBox="0 0 24 24"
																fill="currentColor"
																><path
																	d="M15.4 8.6 12 2 8.6 8.6 2 12l6.6 3.4L12 22l3.4-6.6L22 12l-6.6-3.4Z"
																/></svg
															>
														</span>
														<span class="meta-text">api</span>
														<span class="meta-sep">/</span>
														<span class="meta-text">1h ago</span>
														<span class="revision-pip">v2</span>
													</div>
													<div class="solus-plan-card-actions">
														<button
															class="solus-card-icon-btn"
															aria-hidden="true"
														>
															<svg
																width="11"
																height="11"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																><path d="M7 17 17 7" /><path
																	d="M7 7h10v10"
																/></svg
															>
														</button>
														<button
															class="solus-card-icon-btn"
															aria-hidden="true"
														>
															<svg
																width="11"
																height="11"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																><path
																	d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
																/></svg
															>
														</button>
													</div>
												</div>
												<div class="solus-plan-card-title">
													Pull error types into shared module
												</div>
												<div class="solus-plan-card-excerpt">
													Centralise AppError base class.
												</div>
											</div>
										</div>
										<div class="solus-plan-card accepted">
											<div class="solus-plan-card-accent"></div>
											<div class="solus-plan-card-body">
												<div class="solus-plan-card-header">
													<div class="solus-plan-card-meta">
														<span
															class="solus-plan-card-provider claude"
															aria-hidden="true"
														>
															<svg
																width="10"
																height="10"
																viewBox="0 0 24 24"
																fill="currentColor"
																><path
																	d="M15.4 8.6 12 2 8.6 8.6 2 12l6.6 3.4L12 22l3.4-6.6L22 12l-6.6-3.4Z"
																/></svg
															>
														</span>
														<span class="meta-text">api</span>
														<span class="meta-sep">/</span>
														<span class="meta-text">3h ago</span>
													</div>
													<div class="solus-plan-card-actions">
														<button
															class="solus-card-icon-btn"
															aria-hidden="true"
														>
															<svg
																width="11"
																height="11"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																><path d="M7 17 17 7" /><path
																	d="M7 7h10v10"
																/></svg
															>
														</button>
														<button
															class="solus-card-icon-btn"
															aria-hidden="true"
														>
															<svg
																width="11"
																height="11"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																><path
																	d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
																/></svg
															>
														</button>
													</div>
												</div>
												<div class="solus-plan-card-title">
													Wire telemetry into request handlers
												</div>
												<div class="solus-plan-card-excerpt">
													Attach span IDs to every outbound call.
												</div>
											</div>
										</div>
									</div>
								</div>
							{/if}
						</div>
					</div>

					<!-- Status bar — matches StatusBarControls.svelte -->
					<div class="solus-statusbar editor">
						<span class="solus-statusbar-item">
							<svg
								width="11"
								height="11"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								aria-hidden="true"
								><path
									d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
								/></svg
							>
							~/projects/api
						</span>
						<span class="solus-statusbar-sep">|</span>
						<span class="solus-statusbar-item">
							<svg
								width="10"
								height="10"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								aria-hidden="true"
								><path d="M6 3v12a3 3 0 0 0 3 3h6" /><path
									d="M18 9a3 3 0 0 0-3-3H9"
								/></svg
							>
							main
						</span>
						<span class="solus-statusbar-sep">|</span>
						<span class="solus-statusbar-picker">claude-opus-4-5</span>
						<span class="solus-statusbar-sep">|</span>
						<span class="solus-statusbar-picker">ask mode</span>
						<span class="solus-statusbar-spacer"></span>
						<span class="solus-statusbar-picker">Claude Code</span>
						<span class="solus-statusbar-settings" aria-hidden="true">
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								><circle cx="12" cy="12" r="3" /><path
									d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
								/></svg
							>
						</span>
					</div>
				</div>
			</div>
		</div>

		{#if loopPhaseLabel}
			<div class="v2-feature-label" aria-live="polite">
				{loopPhaseLabel}
			</div>
		{/if}
	</div>
	</div>
</section>

<!-- Section after hero — Three-act zoom -->
<section
	class="px-10 py-[160px] max-[1800px]:py-[110px] max-lg:px-6 max-lg:py-20"
>
	<div class="max-w-[1200px] mx-auto flex flex-col gap-20 max-lg:gap-14">
		<div class="flex flex-col gap-5 max-w-[640px]">
			<div
				class="reveal font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#B08D3E]"
			>
				What Solus is for
			</div>
			<h2
				class="reveal reveal-d1 font-[family-name:var(--font-display)] text-[clamp(30px,3.8vw,52px)] max-[1440px]:text-[clamp(27px,3.4vw,52px)] font-semibold tracking-[-0.038em] leading-[1.1] max-w-[22ch] text-balance"
			>
				Three things the terminal makes
				<em class="not-italic text-[#D4AF6A]">harder than they need to be</em>.
			</h2>
		</div>

		<!-- Row 1: pain left, product right -->
		<div class="po-trio-row reveal">
			<div class="po-trio-pain">
				<div class="po-trio-eyebrow">01 / Context-switch tax</div>
				<h3 class="po-trio-h">23 minutes lost per interruption.</h3>
				<p class="po-trio-p">
					UC Irvine research puts the cost of an interruption at 23 minutes to
					refocus. Solus stays on top of your editor — invoked in 0.2s, gone
					the moment you're done.
				</p>
				<div class="po-trio-stat">
					<span class="po-trio-stat-n">0.2s</span>
					<span class="po-trio-stat-l">⌥+Space → typing</span>
				</div>
			</div>
			<div class="po-trio-stage">
				<div class="po-trio-stage-bg" aria-hidden="true">
					<div class="po-code-line">
						<span class="kw">function</span> <span class="fn">handle</span>()
						&lbrace;
					</div>
					<div class="po-code-line">
						<span class="kw">return</span> processQueue();
					</div>
					<div class="po-code-line">&rbrace;</div>
				</div>
				<div class="po-trio-pill solus-input-pill compact">
					<div class="solus-action-row">
						<div class="solus-action-btns">
							<span class="solus-icon">
								<svg
									width="13"
									height="13"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"><path d="M12 5v14M5 12h14" /></svg
								>
							</span>
						</div>
						<div class="solus-vline"></div>
						<div class="solus-input">
							<span>Add error handling to handle()</span>
							<span class="solus-input-cursor"></span>
						</div>
						<div class="solus-send-group">
							<span class="solus-mic" aria-hidden="true">
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<path
										d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"
									/>
									<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
									<path d="M12 19v3" />
									<path d="M9 22c1 .5 3 .5 6 0" />
								</svg>
							</span>
							<span class="solus-send armed" aria-hidden="true">
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<line x1="22" y1="2" x2="11" y2="13" />
									<polygon points="22 2 15 22 11 13 2 9 22 2" />
								</svg>
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Row 2: product left, pain right -->
		<div class="po-trio-row po-trio-row-rev reveal">
			<div class="po-trio-stage">
				<div class="solus-diff po-trio-stage-diff">
					<div class="solus-diff-toolbar">
						<svg
							width="10"
							height="10"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							style="color:#8a8a80;flex-shrink:0"
							aria-hidden="true"
							><path d="M6 3v12a3 3 0 0 0 3 3h6" /><path
								d="M18 9a3 3 0 0 0-3-3H9"
							/></svg
						>
						<span class="solus-diff-branch">feat/user-service</span>
						<span class="solus-diff-branch-arrow">→</span>
						<span class="solus-diff-branch-target">main</span>
						<span class="solus-diff-stats"
							><span class="add">+12</span><span class="del">−4</span></span
						>
						<div class="solus-diff-toolbar-spacer"></div>
						<button class="solus-diff-ghost-btn" aria-hidden="true">
							<svg
								width="10"
								height="10"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path
									d="M21 3l-7 7"
								/><path d="M3 21l7-7" /></svg
							>
						</button>
						<button class="solus-diff-ghost-btn" aria-hidden="true">
							<svg
								width="10"
								height="10"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								><line x1="18" y1="6" x2="6" y2="18" /><line
									x1="6"
									y1="6"
									x2="18"
									y2="18"
								/></svg
							>
						</button>
					</div>
					<div class="solus-diff-body">
						<div class="solus-diff-line context compact">
							<span class="num">18</span><span class="mark"> </span><span
								class="code">async getUser(id: string) &lbrace;</span
							>
						</div>
						<div class="solus-diff-line del compact">
							<span class="num">19</span><span class="mark">−</span><span
								class="code"
							>
								const u = await db.find(id);</span
							>
						</div>
						<div class="solus-diff-line add compact">
							<span class="num">19</span><span class="mark">+</span><span
								class="code"
							>
								const u = await db.users.find(id);</span
							>
						</div>
						<div class="solus-diff-line add compact" data-commented="true">
							<span class="num">20</span><span class="mark">+</span><span
								class="code"
							>
								if (!u) throw new NotFound(id);</span
							>
						</div>
						<div class="solus-diff-line context compact">
							<span class="num">21</span><span class="mark"> </span><span
								class="code"
							>
								return u;</span
							>
						</div>
					</div>
				</div>
			</div>
			<div class="po-trio-pain">
				<div class="po-trio-eyebrow">02 / Reviewing in scrollback</div>
				<h3 class="po-trio-h">Diffs deserve more than a chat log.</h3>
				<p class="po-trio-p">
					Click any line, leave a comment, send the thread back to your agent.
					Side-by-side or unified, with file count and jump-to-hunk built in.
				</p>
				<div class="po-trio-stat">
					<span class="po-trio-stat-n">+12 / −4</span>
					<span class="po-trio-stat-l">live, per-file</span>
				</div>
			</div>
		</div>

		<!-- Row 3: pain left, product right -->
		<div class="po-trio-row reveal">
			<div class="po-trio-pain">
				<div class="po-trio-eyebrow">03 / Disposable plans</div>
				<h3 class="po-trio-h">Plans shouldn't disappear when you scroll.</h3>
				<p class="po-trio-p">
					Every plan your agent drafts is saved, searchable, and revisitable.
					Accept, reject, branch — and never lose track of what was tried.
				</p>
				<div class="po-trio-stat">
					<span class="po-trio-stat-n">∞</span>
					<span class="po-trio-stat-l">searchable history</span>
				</div>
			</div>
			<div class="po-trio-stage">
				<div class="po-trio-plan-modal">
					<!-- Header -->
					<div class="plan-mock-header">
						<div class="plan-mock-header-left">
							<span class="plan-mock-title">Review Plan</span>
						</div>
						<div class="plan-mock-header-right">
							<button class="plan-mock-close" aria-hidden="true">
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									><line x1="18" y1="6" x2="6" y2="18" /><line
										x1="6"
										y1="6"
										x2="18"
										y2="18"
									/></svg
								>
							</button>
						</div>
					</div>
					<!-- Toolbar -->
					<div class="plan-mock-toolbar">
						<button class="plan-mock-tb-btn" aria-hidden="true"
							><strong>B</strong></button
						>
						<button class="plan-mock-tb-btn" aria-hidden="true"
							><em>I</em></button
						>
						<button class="plan-mock-tb-btn" aria-hidden="true"><s>S</s></button
						>
						<button class="plan-mock-tb-btn" aria-hidden="true"
							><code>&lt;/&gt;</code></button
						>
						<button class="plan-mock-tb-btn" aria-hidden="true">
							<svg
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								><path
									d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
								/><path
									d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
								/></svg
							>
						</button>
						<span class="plan-mock-tb-sep"></span>
						<button
							class="plan-mock-tb-btn plan-mock-tb-text"
							aria-hidden="true">H<sub>1</sub></button
						>
						<button
							class="plan-mock-tb-btn plan-mock-tb-text"
							aria-hidden="true">H<sub>2</sub></button
						>
						<button
							class="plan-mock-tb-btn plan-mock-tb-text"
							aria-hidden="true">H<sub>3</sub></button
						>
						<span class="plan-mock-tb-sep"></span>
						<button class="plan-mock-tb-btn" aria-hidden="true">
							<svg
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								><line x1="8" y1="6" x2="21" y2="6" /><line
									x1="8"
									y1="12"
									x2="21"
									y2="12"
								/><line x1="8" y1="18" x2="21" y2="18" /><circle
									cx="4"
									cy="6"
									r="1"
									fill="currentColor"
								/><circle cx="4" cy="12" r="1" fill="currentColor" /><circle
									cx="4"
									cy="18"
									r="1"
									fill="currentColor"
								/></svg
							>
						</button>
						<button class="plan-mock-tb-btn" aria-hidden="true">
							<svg
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								><line x1="10" y1="6" x2="21" y2="6" /><line
									x1="10"
									y1="12"
									x2="21"
									y2="12"
								/><line x1="10" y1="18" x2="21" y2="18" /><text
									x="3"
									y="8"
									font-size="7"
									fill="currentColor"
									stroke="none">1.</text
								><text
									x="3"
									y="14"
									font-size="7"
									fill="currentColor"
									stroke="none">2.</text
								><text
									x="3"
									y="20"
									font-size="7"
									fill="currentColor"
									stroke="none">3.</text
								></svg
							>
						</button>
						<button class="plan-mock-tb-btn" aria-hidden="true">
							<svg
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								><path
									d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"
								/></svg
							>
						</button>
						<span class="plan-mock-tb-sep"></span>
						<button
							class="plan-mock-tb-btn plan-mock-tb-mode"
							aria-hidden="true"
						>
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								><path
									d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"
								/><polyline points="13 2 13 9 20 9" /></svg
							>
							Markdown
						</button>
					</div>
					<!-- Content -->
					<div class="plan-mock-content">
						<div class="plan-mock-doc">
							<h2 class="plan-mock-h2">Error handling strategy</h2>
							<p class="plan-mock-p">
								Replace raw try/catch blocks with a typed <code
									>Result&lt;T, E&gt;</code
								> pattern across the API layer.
							</p>
							<h3 class="plan-mock-h3">Steps</h3>
							<ol class="plan-mock-ol">
								<li>
									Define <code>Result&lt;T, E&gt;</code> discriminated union in
									<code>shared/result.ts</code>
								</li>
								<li class="plan-mock-highlight">
									Refactor <code>UserService</code> to return
									<code>Result</code> types
								</li>
								<li>Update route handlers to pattern-match on result</li>
								<li>Add exhaustive error mapping to HTTP status codes</li>
							</ol>
						</div>
					</div>
					<!-- Action bar -->
					<div class="plan-mock-actionbar">
						<div class="solus-plan-action-textarea" aria-hidden="true">
							Add a note… <span class="solus-kbd-hint">⌥L</span>
						</div>
						<div class="solus-plan-action-btns">
							<div class="solus-plan-action-left">
								<button class="solus-plan-btn solus-plan-btn-ghost"
									>Reject <span class="solus-kbd-hint">⌥R</span></button
								>
								<button class="solus-plan-btn solus-plan-btn-ghost"
									>No, revise <span class="solus-kbd-hint">⌥V</span></button
								>
							</div>
							<div class="solus-plan-action-right">
								<button class="solus-plan-btn solus-plan-btn-accent-soft"
									>✓ Yes (auto) <span class="solus-kbd-hint">⌥A</span></button
								>
								<button class="solus-plan-btn solus-plan-btn-primary"
									>✓ Yes <span class="solus-kbd-hint">⌥Y</span></button
								>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</section>

<!-- How it works -->
<section
	id="how-it-works"
	class="px-10 py-[160px] max-[1800px]:py-[110px] border-t border-black/[0.07] max-lg:px-6 max-lg:py-20"
>
	<div class="max-w-[1200px] mx-auto flex flex-col gap-14">
		<div class="flex flex-col gap-5 max-w-[640px]">
			<div
				class="reveal font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#B08D3E]"
			>
				How it works
			</div>
			<h2
				class="reveal reveal-d1 font-[family-name:var(--font-display)] text-[clamp(30px,3.8vw,52px)] max-[1440px]:text-[clamp(27px,3.4vw,52px)] font-semibold tracking-[-0.038em] leading-[1.1] max-w-[22ch] text-balance"
			>
				Four chords.<br />
				<em class="not-italic text-[#D4AF6A]">No mouse required.</em>
			</h2>
			<p
				class="reveal reveal-d2 text-base/7 sm:text-[16px] max-[1440px]:sm:text-[15px] leading-[1.75] text-[#6B6158] max-w-[52ch] text-pretty"
			>
				Solus is keyboard-first. The whole flow — invoke, ask, review, dismiss —
				fits in four chords you'll never have to look up again.
			</p>
		</div>

		<div class="po-cheat reveal reveal-d2">
			<div class="po-cheat-card">
				<div class="po-cheat-chord">
					<kbd class="po-cheat-kbd">⌥</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd po-cheat-kbd-wide">Space</kbd>
				</div>
				<div class="po-cheat-body">
					<div class="po-cheat-num">01</div>
					<h3 class="po-cheat-title">Toggle</h3>
					<p class="po-cheat-desc">
						Bring Solus to front. From anywhere, in any app.
					</p>
				</div>
			</div>

			<div class="po-cheat-card">
				<div class="po-cheat-chord">
					<kbd class="po-cheat-kbd">⌥</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd">⇧</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd">T</kbd>
				</div>
				<div class="po-cheat-body">
					<div class="po-cheat-num">02</div>
					<h3 class="po-cheat-title">New tab</h3>
					<p class="po-cheat-desc">
						Spawn a fresh agent session. Work many threads at once.
					</p>
				</div>
			</div>

			<div class="po-cheat-card">
				<div class="po-cheat-chord">
					<kbd class="po-cheat-kbd">⌥</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd">⇧</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd">E</kbd>
				</div>
				<div class="po-cheat-body">
					<div class="po-cheat-num">03</div>
					<h3 class="po-cheat-title">Editor mode</h3>
					<p class="po-cheat-desc">
						Expand to plan view, diff review, or the full session.
					</p>
				</div>
			</div>

			<div class="po-cheat-card">
				<div class="po-cheat-chord">
					<kbd class="po-cheat-kbd po-cheat-kbd-wide">Esc</kbd>
				</div>
				<div class="po-cheat-body">
					<div class="po-cheat-num">04</div>
					<h3 class="po-cheat-title">Dismiss</h3>
					<p class="po-cheat-desc">
						Send Solus back. Editor takes over — exactly where you left off.
					</p>
				</div>
			</div>
		</div>

		<div class="po-cheat-meta reveal reveal-d3">
			<div class="po-cheat-meta-stat">
				<span class="po-cheat-meta-n">0.2s</span>
				<span class="po-cheat-meta-l">overlay → typing</span>
			</div>
			<div class="po-cheat-meta-sep" aria-hidden="true"></div>
			<div class="po-cheat-meta-stat">
				<span class="po-cheat-meta-n">3</span>
				<span class="po-cheat-meta-l">keystrokes per request</span>
			</div>
			<div class="po-cheat-meta-sep" aria-hidden="true"></div>
			<div class="po-cheat-meta-stat">
				<span class="po-cheat-meta-n">∞</span>
				<span class="po-cheat-meta-l">tabs in flight</span>
			</div>
		</div>
	</div>
</section>

<!-- Features -->
<section
	id="features"
	class="px-10 py-[160px] max-[1800px]:py-[110px] border-t border-black/[0.07] max-lg:px-6 max-lg:py-20"
>
	<div class="max-w-[1200px] mx-auto flex flex-col gap-14">
		<div class="flex flex-col gap-5 max-w-[640px]">
			<div
				class="reveal font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#B08D3E]"
			>
				Features
			</div>
			<h2
				class="reveal reveal-d1 font-[family-name:var(--font-display)] text-[clamp(30px,3.8vw,52px)] max-[1440px]:text-[clamp(27px,3.4vw,52px)] font-semibold tracking-[-0.038em] leading-[1.1] max-w-[20ch] text-balance"
			>
				Your agent's work,<br />
				<em class="not-italic text-[#D4AF6A]">in an interface you can actually drive.</em>
			</h2>
		</div>

		<div class="po-bento reveal reveal-d2">
			<!-- Hero card: Interactive review plans -->
			<div class="po-bento-card po-bento-hero">
				<div class="po-bento-mock po-bento-mock-plan">
					<div class="po-bento-plan-head">
						<span class="po-bento-plan-title">Review Plan · v3</span>
						<span class="po-bento-plan-pill">2 comments</span>
					</div>
					<div class="po-bento-plan-body">
						<div class="po-bento-plan-line">
							<span class="po-bento-plan-num">1.</span> Check HTTP status before parsing
						</div>
						<div class="po-bento-plan-line po-bento-plan-active">
							<span class="po-bento-plan-num">2.</span> Add <code>User</code> type
							annotation
						</div>
						<div class="po-bento-plan-line">
							<span class="po-bento-plan-num">3.</span> Wrap network call in try/catch
						</div>
					</div>
					<div class="po-bento-plan-foot">
						<div class="solus-plan-action-mock">
							<div class="solus-plan-action-textarea" aria-hidden="true">
								Add a note… <span class="solus-kbd-hint">⌥L</span>
							</div>
							<div class="solus-plan-action-btns">
								<div class="solus-plan-action-left">
									<button class="solus-plan-btn solus-plan-btn-ghost"
										>Reject <span class="solus-kbd-hint">⌥R</span></button
									>
								</div>
								<div class="solus-plan-action-right">
									<button class="solus-plan-btn solus-plan-btn-accent-soft"
										>✓ Yes (auto) <span class="solus-kbd-hint">⌥A</span></button
									>
									<button class="solus-plan-btn solus-plan-btn-primary"
										>✓ Yes <span class="solus-kbd-hint">⌥Y</span></button
									>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div class="po-bento-body">
					<div class="po-bento-num">01</div>
					<h3 class="po-bento-title">Interactive review plans</h3>
					<p class="po-bento-desc">
						Before your agent touches a file, it shows you its full plan.
						Annotate steps inline, strike out what you disagree with, approve
						when ready.
					</p>
				</div>
			</div>

			<!-- Wide card: Design Mode -->
			<div class="po-bento-card po-bento-wide">
				<div class="po-bento-mock po-bento-mock-design">
					<div class="po-bento-design-frame">
						<svg viewBox="0 0 220 130" class="po-bento-design-svg">
							<rect
								x="0"
								y="0"
								width="220"
								height="130"
								rx="6"
								fill="rgba(60,57,41,0.08)"
							/>
							<rect
								x="14"
								y="14"
								width="76"
								height="44"
								rx="4"
								fill="rgba(60,57,41,0.14)"
								stroke="#d97757"
								stroke-width="1.5"
								stroke-dasharray="3 3"
							/>
							<circle cx="140" cy="44" r="13" fill="#d97757" opacity="0.92" />
							<text
								x="140"
								y="49"
								text-anchor="middle"
								font-family="var(--font-mono)"
								font-size="11"
								font-weight="700"
								fill="#fff">1</text
							>
							<line
								x1="90"
								y1="36"
								x2="127"
								y2="40"
								stroke="#d97757"
								stroke-width="1.5"
								stroke-linecap="round"
							/>
							<polygon points="127,40 121,38 124,34" fill="#d97757" />
							<rect
								x="100"
								y="78"
								width="80"
								height="36"
								rx="4"
								fill="rgba(60,57,41,0.10)"
								stroke="#d97757"
								stroke-width="1.5"
							/>
							<circle cx="180" cy="96" r="13" fill="#d97757" opacity="0.92" />
							<text
								x="180"
								y="101"
								text-anchor="middle"
								font-family="var(--font-mono)"
								font-size="11"
								font-weight="700"
								fill="#fff">2</text
							>
							<text
								x="14"
								y="120"
								font-family="var(--font-mono)"
								font-size="9"
								fill="rgba(60,57,41,0.55)">Fix CTA spacing</text
							>
						</svg>
					</div>
				</div>
				<div class="po-bento-body">
					<div class="po-bento-num">02</div>
					<h3 class="po-bento-title">Design Mode</h3>
					<p class="po-bento-desc">
						Screenshot, annotate with rectangles, arrows and pins, send the
						marked-up image straight to your agent. Point at exactly what needs
						fixing.
					</p>
				</div>
			</div>

			<!-- Small cards row -->
			<div class="po-bento-card po-bento-small">
				<div class="po-bento-icon">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
						<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
						<path d="M12 19v3" />
						<path d="M9 22c1 .5 3 .5 6 0" />
					</svg>
				</div>
				<div class="po-bento-body">
					<div class="po-bento-num">03</div>
					<h3 class="po-bento-title-sm">Continuous voice</h3>
					<p class="po-bento-desc-sm">
						Hold the mic open. Solus listens, transcribes, and sends when you
						pause.
					</p>
				</div>
			</div>

			<div class="po-bento-card po-bento-small">
				<div class="po-bento-icon">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<rect x="2" y="4" width="20" height="4" rx="1" />
						<rect x="2" y="10" width="20" height="4" rx="1" />
						<rect x="2" y="16" width="14" height="4" rx="1" />
						<circle cx="19" cy="18" r="3" />
						<path d="M19 16.5v1.5l1 .75" />
					</svg>
				</div>
				<div class="po-bento-body">
					<div class="po-bento-num">04</div>
					<h3 class="po-bento-title-sm">Rate-limit queue</h3>
					<p class="po-bento-desc-sm">
						Hit a limit? Solus queues and retries when the window resets — no
						babysitting.
					</p>
				</div>
			</div>

			<div class="po-bento-card po-bento-small">
				<div class="po-bento-icon">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path
							d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
						/>
						<polyline points="14 2 14 8 20 8" />
						<path d="M10 12l2 2 4-4" />
					</svg>
				</div>
				<div class="po-bento-body">
					<div class="po-bento-num">05</div>
					<h3 class="po-bento-title-sm">Jump to file</h3>
					<p class="po-bento-desc-sm">
						Click any path in a response — opens at the exact line in VS Code or
						Zed.
					</p>
				</div>
			</div>

			<div class="po-bento-card po-bento-small">
				<div class="po-bento-icon">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
					</svg>
				</div>
				<div class="po-bento-body">
					<div class="po-bento-num">06</div>
					<h3 class="po-bento-title-sm">Rich editor</h3>
					<p class="po-bento-desc-sm">
						Inline formatting, slash menu, code blocks and tables — built into
						every reply.
					</p>
				</div>
			</div>

			<!-- Wide card: Works & Google Docs -->
			<div class="po-bento-card po-bento-wide">
				<div class="po-bento-mock po-bento-mock-works">
					<div class="po-bento-works-scene">
						<!-- Document card -->
						<div class="po-bento-works-doc">
							<div class="po-bento-works-doc-head">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5a5749" stroke-width="1.8" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
								<span class="po-bento-works-doc-title">API error handling</span>
							</div>
							<div class="po-bento-works-doc-body">
								<div class="po-bento-works-line"></div>
								<div class="po-bento-works-line short"></div>
								<div class="po-bento-works-line medium"></div>
								<div class="po-bento-works-line"></div>
								<div class="po-bento-works-line short"></div>
							</div>
							<div class="po-bento-works-doc-foot">
								<span class="po-bento-works-badge">doc</span>
								<span class="po-bento-works-time">2m ago</span>
							</div>
						</div>

						<!-- Arrow -->
						<div class="po-bento-works-arrow">
							<svg viewBox="0 0 48 24" fill="none" class="po-bento-works-arrow-svg">
								<path d="M0 12h44" stroke="#D4AF6A" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.5"/>
								<polygon points="44,12 38,9 38,15" fill="#D4AF6A" opacity="0.7"/>
							</svg>
						</div>

						<!-- Google Docs icon -->
						<div class="po-bento-works-gdocs">
							<svg width="28" height="28" viewBox="0 0 24 24" fill="none">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="#4285F4" opacity="0.15" stroke="#4285F4" stroke-width="1.5"/>
								<polyline points="14 2 14 8 20 8" fill="none" stroke="#4285F4" stroke-width="1.5"/>
								<line x1="8" y1="13" x2="16" y2="13" stroke="#4285F4" stroke-width="1.2" opacity="0.6"/>
								<line x1="8" y1="16" x2="14" y2="16" stroke="#4285F4" stroke-width="1.2" opacity="0.6"/>
								<line x1="8" y1="19" x2="12" y2="19" stroke="#4285F4" stroke-width="1.2" opacity="0.6"/>
							</svg>
							<span class="po-bento-works-gdocs-label">Google Docs</span>
						</div>
					</div>
				</div>
				<div class="po-bento-body">
					<div class="po-bento-num">07</div>
					<h3 class="po-bento-title">Works &amp; Google Docs</h3>
					<p class="po-bento-desc">
						Your agent drafts documents that live in Solus as Works. One shortcut exports any Work straight to Google Docs — ready to share.
					</p>
				</div>
			</div>

			<!-- Wide card: Remote Connection -->
			<div class="po-bento-card po-bento-wide">
				<div class="po-bento-mock po-bento-mock-remote">
					<div class="po-bento-remote-scene">
						<!-- Desktop -->
						<div class="po-bento-remote-desktop">
							<svg viewBox="0 0 56 44" fill="none" class="po-bento-remote-device">
								<rect x="2" y="2" width="52" height="34" rx="3" stroke="#5a5749" stroke-width="1.5" fill="rgba(60,57,41,0.06)"/>
								<rect x="6" y="6" width="44" height="26" rx="1.5" fill="rgba(60,57,41,0.10)"/>
								<rect x="20" y="38" width="16" height="2" rx="1" fill="#5a5749" opacity="0.4"/>
								<circle cx="28" cy="10" r="2" fill="#d97757" opacity="0.9"/>
								<rect x="10" y="14" width="20" height="2" rx="1" fill="#5a5749" opacity="0.25"/>
								<rect x="10" y="19" width="14" height="2" rx="1" fill="#5a5749" opacity="0.15"/>
								<rect x="10" y="24" width="18" height="2" rx="1" fill="#5a5749" opacity="0.15"/>
							</svg>
							<span class="po-bento-remote-label">Solus Desktop</span>
						</div>

						<!-- Connection beam -->
						<div class="po-bento-remote-beam">
							<svg viewBox="0 0 80 24" fill="none" class="po-bento-remote-beam-svg">
								<path d="M0 12h80" stroke="#D4AF6A" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.5"/>
								<circle cx="20" cy="12" r="2.5" fill="#D4AF6A" opacity="0.7" class="po-bento-remote-dot po-bento-remote-dot-1"/>
								<circle cx="40" cy="12" r="2.5" fill="#D4AF6A" opacity="0.7" class="po-bento-remote-dot po-bento-remote-dot-2"/>
								<circle cx="60" cy="12" r="2.5" fill="#D4AF6A" opacity="0.7" class="po-bento-remote-dot po-bento-remote-dot-3"/>
							</svg>
						</div>

						<!-- Phone -->
						<div class="po-bento-remote-phone">
							<svg viewBox="0 0 32 52" fill="none" class="po-bento-remote-device">
								<rect x="2" y="2" width="28" height="48" rx="5" stroke="#5a5749" stroke-width="1.5" fill="rgba(60,57,41,0.06)"/>
								<rect x="5" y="8" width="22" height="36" rx="2" fill="rgba(60,57,41,0.10)"/>
								<rect x="12" y="4" width="8" height="2" rx="1" fill="#5a5749" opacity="0.3"/>
								<circle cx="16" cy="48" r="1.5" fill="#5a5749" opacity="0.25"/>
								<circle cx="16" cy="14" r="2" fill="#d97757" opacity="0.9"/>
								<rect x="8" y="18" width="12" height="1.5" rx="0.75" fill="#5a5749" opacity="0.25"/>
								<rect x="8" y="22" width="9" height="1.5" rx="0.75" fill="#5a5749" opacity="0.15"/>
							</svg>
							<span class="po-bento-remote-label">Any browser</span>
						</div>
					</div>
				</div>
				<div class="po-bento-body">
					<div class="po-bento-num">08</div>
					<h3 class="po-bento-title">Remote connection</h3>
					<p class="po-bento-desc">
						Open Solus in any browser — phone, tablet, another machine. Pair once with a link, and your full workspace streams over the local network.
					</p>
				</div>
			</div>
		</div>
	</div>
</section>

<!-- Works with -->
<section
	class="px-10 py-[160px] max-[1800px]:py-[110px] border-t border-black/[0.07] max-lg:px-6 max-lg:py-20"
>
	<div class="max-w-[1200px] mx-auto flex flex-col gap-14">
		<div class="flex flex-col gap-5 max-w-[640px]">
			<div
				class="reveal font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#B08D3E]"
			>
				Works with
			</div>
			<h2
				class="reveal reveal-d1 font-[family-name:var(--font-display)] text-[clamp(30px,3.8vw,52px)] max-[1440px]:text-[clamp(27px,3.4vw,52px)] font-semibold tracking-[-0.038em] leading-[1.1] max-w-[22ch] text-balance"
			>
				Bring your own <em class="not-italic text-[#D4AF6A]">agent.</em>
			</h2>
			<p class="reveal reveal-d2 text-base/7 sm:text-[16px] max-[1440px]:sm:text-[15px] leading-[1.75] text-[#6B6158] max-w-[52ch] text-pretty">
				Solus is model-agnostic. It wraps the agents you already use — and connects to Google Workspace for one-shortcut export. Switch providers anytime; your workflow stays put.
			</p>
		</div>

		<div class="reveal reveal-d2 grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-[760px] mx-auto w-full">
			<!-- Claude Code -->
			<div class="flex flex-col items-center gap-3 px-4 py-6 rounded-2xl border border-black/[0.06] bg-white/60">
				<div class="size-10 rounded-xl bg-[#d97757]/10 flex items-center justify-center">
					<svg width="18" height="18" viewBox="0 0 16 16" fill="#d97757">
						<path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/>
					</svg>
				</div>
				<span class="text-[13px] font-medium text-[#1A1714] text-center leading-tight">Claude Code</span>
			</div>

			<!-- Codex -->
			<div class="flex flex-col items-center gap-3 px-4 py-6 rounded-2xl border border-black/[0.06] bg-white/60">
				<div class="size-10 rounded-xl bg-[#10a37f]/10 flex items-center justify-center">
					<svg width="18" height="18" viewBox="0 0 16 16" fill="#10a37f">
						<path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"/>
					</svg>
				</div>
				<span class="text-[13px] font-medium text-[#1A1714] text-center leading-tight">Codex</span>
			</div>

			<!-- Google Workspace -->
			<div class="flex flex-col items-center gap-3 px-4 py-6 rounded-2xl border border-black/[0.06] bg-white/60">
				<div class="size-10 rounded-xl bg-[#4285F4]/10 flex items-center justify-center">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
						<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
						<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
						<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
						<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
					</svg>
				</div>
				<span class="text-[13px] font-medium text-[#1A1714] text-center leading-tight">Google Workspace</span>
			</div>

			<!-- Copilot -->
			<div class="flex flex-col items-center gap-3 px-4 py-6 rounded-2xl border border-black/[0.06] bg-white/60 relative">
				<div class="size-10 rounded-xl bg-black/[0.04] flex items-center justify-center">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="#6B6158" opacity="0.5">
						<path d="M23.922 16.992c-.861 1.495-5.859 5.023-11.922 5.023-6.063 0-11.061-3.528-11.922-5.023A.641.641 0 0 1 0 16.736v-2.869a.841.841 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.195 10.195 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952 1.399-1.136 3.392-2.093 6.122-2.093 2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.832.832 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256ZM12.172 11h-.344a4.323 4.323 0 0 1-.355.508C10.703 12.455 9.555 13 7.965 13c-1.725 0-2.989-.359-3.782-1.259a2.005 2.005 0 0 1-.085-.104L4 11.741v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.323 4.323 0 0 1-.355-.508h-.016.016Zm.641-2.935c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"/>
						<path d="M14.5 14.25a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Zm-5 0a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Z"/>
					</svg>
				</div>
				<span class="text-[13px] font-medium text-[#6B6158]/70 text-center leading-tight">Copilot</span>
				<span class="absolute top-2.5 right-2.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-[#D4AF6A] bg-[#D4AF6A]/10 px-1.5 py-0.5 rounded-full">Soon</span>
			</div>

		</div>
	</div>
</section>

<!-- CTA -->
<section
	class="relative overflow-hidden px-10 py-[180px] max-[1800px]:py-[130px] border-t border-black/[0.07] max-lg:px-6 max-lg:py-24"
>
	<div class="absolute inset-0 pointer-events-none" aria-hidden="true">
		<div
			class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px]"
			style="background: radial-gradient(ellipse, rgba(212,175,106,0.09) 0%, transparent 65%); filter: blur(60px);"
		></div>
		<svg
			class="absolute inset-0 w-full h-full"
			xmlns="http://www.w3.org/2000/svg"
		>
			<circle cx="12%" cy="20%" r="3" fill="#D4AF6A" opacity="0.12" />
			<circle cx="88%" cy="15%" r="5" fill="#D4AF6A" opacity="0.08" />
			<circle cx="5%" cy="70%" r="2" fill="#D4AF6A" opacity="0.10" />
			<circle cx="93%" cy="65%" r="4" fill="#D4AF6A" opacity="0.09" />
			<circle cx="22%" cy="85%" r="2.5" fill="#D4AF6A" opacity="0.08" />
			<circle cx="78%" cy="80%" r="3" fill="#D4AF6A" opacity="0.07" />
			<circle cx="50%" cy="8%" r="2" fill="#D4AF6A" opacity="0.10" />
			<circle cx="35%" cy="92%" r="1.5" fill="#D4AF6A" opacity="0.08" />
			<circle cx="65%" cy="90%" r="2.5" fill="#D4AF6A" opacity="0.06" />
		</svg>
	</div>
	<div class="max-w-[720px] mx-auto flex flex-col gap-7 relative">
		<div
			class="reveal flex items-center gap-2.5 font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[#6B6158] uppercase tracking-[0.12em]"
		>
			<span
				class="w-[6px] h-[6px] rounded-full bg-[#D4AF6A] shrink-0"
				style="animation: breathe 2.4s ease-in-out infinite"
			></span>
			Available now
		</div>

		<h2
			class="reveal reveal-d1 font-[family-name:var(--font-display)] text-[clamp(36px,5vw,64px)] font-semibold tracking-[-0.045em] leading-[1] text-[#1A1714] max-w-[20ch] text-balance"
		>
			Your agent deserves a real interface.
		</h2>

		<p class="reveal reveal-d2 text-base/7 sm:text-[16px] max-[1440px]:sm:text-[15px] leading-[1.65] text-[#6B6158]">
			Built for engineers who never leave the keyboard.
		</p>

		<div class="reveal reveal-d3 flex flex-col gap-3 mt-1">
			<button onclick={downloadApp} class="v2-cta-primary self-start">
				<svg
					width="14"
					height="14"
					viewBox="0 0 814 1000"
					fill="currentColor"
					aria-hidden="true"
				>
					<path
						d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.3-165-39.3c-76.5 0-103.7 40.8-165 40.8s-105-42.7-147.8-103.6c-49-68.9-90.6-176.5-90.6-279C0 469.8 166.4 265 348.6 265 407.5 265 458 304.5 490 304.5c29.8 0 88.8-44.5 163.7-44.5 26.6 0 108.2 2.6 168.6 74.9zm-237.6-74.9c31.8-37.7 54.6-90.1 54.6-142.5 0-7.1-.6-14.3-1.9-20.1-51.9 2-112.3 34.8-149.1 75.5-29.2 32.6-55.1 84.4-55.1 139.8 0 7.7 1.3 15.5 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 46.5 0 102.3-31.2 136-72.1z"
					/>
				</svg>
				Download for macOS
			</button>
			<p class="text-[12px] text-[#6B6158]">
				Free during beta. macOS 13 Ventura or later.
			</p>
		</div>
	</div>
</section>

<!-- Footer -->
<footer class="border-t border-black/[0.07] px-10 py-7 max-sm:px-5 max-sm:py-8">
	<div class="max-w-[1200px] mx-auto flex items-center gap-6 max-sm:flex-col max-sm:items-start max-sm:gap-5">
		<a href="/" class="flex items-center gap-1.5 no-underline">
			<svg
				width="16"
				height="16"
				viewBox="-60 -60 120 120"
				fill="none"
				aria-hidden="true"
			>
				<circle cx="0" cy="0" r="31.2" fill="#D4AF6A" />
				<g stroke="#D4AF6A" stroke-width="10.4" stroke-linecap="round">
					<path d="M 0,-52 A 52,52 0 0 1 52,0" />
					<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
					<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
				</g>
			</svg>
			<span
				class="font-[family-name:var(--font-display)] text-[14px] font-bold tracking-[-0.02em] text-[#1A1714]"
				>Solus</span
			>
		</a>
		<div class="flex flex-wrap gap-5 max-sm:gap-3 sm:ml-auto sm:items-center">
			<a
				href="/docs"
				class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"
				><span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>Docs</a
			>
			<a
				href="/privacy"
				class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"
				><span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>Privacy</a
			>
			<a
				href="/terms"
				class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"
				><span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>Terms</a
			>
			<a
				href="https://x.com/ashtonasidhu"
				target="_blank"
				rel="noopener noreferrer"
				class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"
				><span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>X / Twitter</a
			>
		</div>
		<p class="text-[13px] sm:text-[12px] text-[#A09488] max-sm:order-first max-sm:hidden sm:ml-auto">© 2026 Solus.</p>
		<p class="text-[13px] text-[#A09488] sm:hidden">© 2026 Solus.</p>
	</div>
</footer>
