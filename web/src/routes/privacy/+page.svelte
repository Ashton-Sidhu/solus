<svelte:head>
	<title>Privacy Policy — Solus</title>
	<meta
		name="description"
		content="Solus privacy policy. We don't collect your code, conversations, or personal data — only anonymous feature usage to improve the app."
	/>
</svelte:head>

<div class="grain" aria-hidden="true"></div>

<main class="max-w-[640px] mx-auto px-6 py-24">
	<a
		href="/"
		class="inline-flex items-center gap-1.5 text-[13px] text-[#A09488] no-underline hover:text-[#1A1714] transition-colors mb-12"
	>
		<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
			<path
				d="M8 2L3 7l5 5"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		Back to home
	</a>

	<h1
		class="text-[36px] font-semibold tracking-[-0.035em] leading-[1.1] mb-4 text-[#1A1714]"
	>
		Privacy Policy
	</h1>
	<p class="text-[13px] text-[#A09488] mb-12">Last updated: May 14, 2026</p>

	<div class="flex flex-col gap-10 text-base/7 sm:text-[15px] sm:leading-[1.75] text-[#6B6158]">
		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">Overview</h2>
			<p>
				Solus is a desktop application that runs entirely on your machine. Your
				code, conversations, and files never leave your device through Solus. We
				are committed to keeping your sensitive data private and under your
				control.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">
				What we do <em class="not-italic text-[#A09488]">not</em> collect
			</h2>
			<ul class="list-disc pl-5 flex flex-col gap-2">
				<li>Your prompts, conversations, or AI responses</li>
				<li>Source code, file contents, or file paths</li>
				<li>Your name, email address, or any identifying information</li>
				<li>Crash reports or error logs</li>
				<li>Audio recordings or voice data</li>
			</ul>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">
				Anonymous feature usage
			</h2>
			<p class="mb-4">
				To understand how the app is used and where to focus improvements, Solus
				collects anonymous, aggregate feature usage events via
				<a
					href="https://posthog.com"
					target="_blank"
					rel="noopener noreferrer"
					class="text-[#1A1714] underline underline-offset-2 hover:text-[#A09488] transition-colors"
				>PostHog</a>. Examples of events include:
			</p>
			<ul class="list-disc pl-5 flex flex-col gap-2">
				<li>App opened</li>
				<li>Conversation started</li>
				<li>Message sent</li>
				<li>Agent switched</li>
				<li>Editor / pill mode toggled</li>
				<li>Voice recording started</li>
				<li>Plan gallery opened</li>
				<li>Settings opened</li>
			</ul>
			<p class="mt-4">
				Each installation is assigned a random anonymous identifier. This ID
				cannot be linked back to you — it contains no name, email, or device
				information. No event payload ever includes the content of a message,
				file name, or file path.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">
				Opting out
			</h2>
			<p>
				You can turn off analytics at any time from
				<strong class="text-[#1A1714] font-medium">Settings → General → Share analytics</strong>.
				When disabled, no events are sent and the anonymous identifier is no
				longer used.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">Voice input</h2>
			<p>
				Voice transcription is performed locally on your device using Whisper.
				Audio is never transmitted to our servers or any third party. The only
				data that leaves your machine is the transcribed text sent to the AI
				coding assistant you have configured.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">
				Third-party services
			</h2>
			<p>
				Solus communicates with the AI coding assistant CLI you have installed
				and configured. Your prompts and code are processed according to that
				service's own privacy policy. Solus does not add any intermediary servers
				or proxies.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">
				Data storage
			</h2>
			<p>
				Session history and preferences are stored locally on your machine. We
				do not have access to any of your conversations, code, or files.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">Waitlist</h2>
			<p>
				If you joined our waitlist, we collected your email address solely to
				notify you about Solus availability. You can request deletion of this
				data at any time by contacting us at
				<a
					href="mailto:hello@solus.sh"
					class="text-[#1A1714] underline underline-offset-2 hover:text-[#A09488] transition-colors"
				>hello@solus.sh</a>.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">Your rights</h2>
			<p>
				Since Solus stores all personal data locally, you have full control —
				simply delete the application data from your machine. For waitlist email
				removal or any privacy questions, contact us at
				<a
					href="mailto:hello@solus.sh"
					class="text-[#1A1714] underline underline-offset-2 hover:text-[#A09488] transition-colors"
				>hello@solus.sh</a>.
			</p>
		</section>
	</div>
</main>
