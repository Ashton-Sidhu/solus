<svelte:head>
	<title>Privacy Policy · Solus</title>
	<meta
		name="description"
		content="Solus privacy policy. We don't collect your code, conversations, or personal data, only anonymous feature usage to improve the app."
	/>
</svelte:head>


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
	<p class="text-[13px] text-[#A09488] mb-12">Last updated: October 23, 2026</p>

	<div
		class="flex flex-col gap-10 text-base/7 sm:text-[15px] sm:leading-[1.75] text-[#6B6158]"
	>
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
					>PostHog</a
				>. Examples of events include:
			</p>
			<ul class="list-disc pl-5 flex flex-col gap-2">
				<li>App opened</li>
				<li>Conversation started</li>
				<li>Message sent</li>
				<li>Agent switched</li>
				<li>Voice recording started</li>
				<li>Plan gallery opened</li>
				<li>Settings opened</li>
			</ul>
			<p class="mt-4">
				Each installation is assigned a random anonymous identifier. This ID
				cannot be linked back to you. It contains no name, email, or device
				information. No event payload ever includes the content of a message,
				file name, or file path.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">Opting out</h2>
			<p>
				You can turn off analytics at any time from
				<strong class="text-[#1A1714] font-medium"
					>Settings → General → Share analytics</strong
				>. When disabled, no events are sent and the anonymous identifier is no
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
				service's own privacy policy. Solus does not add any intermediary
				servers or proxies.
			</p>
		</section>

		<section>
			<h2 class="text-[18px] font-semibold text-[#1A1714] mb-3">
				Google user data
			</h2>
			<p class="mb-4">
				You can connect Google products to Solus so the AI agent can work with
				them for you: Gmail, Google Calendar, Google Drive, Google Docs, Google
				Sheets, Google Slides, Google Forms, Google Tasks, Google Contacts,
				Google Meet, and Google Search Console. Each product is connected
				separately, and Solus asks Google only for access to that product,
				plus your Google account's email address so Solus can show which
				account is connected.
			</p>
			<h3 class="text-[15px] font-semibold text-[#1A1714] mb-2">
				How Solus uses your Google data
			</h3>
			<ul class="list-disc pl-5 flex flex-col gap-2 mb-4">
				<li>
					Solus reads or changes your Google data only to do what you ask in a
					conversation, for example to search your mail, find a free time in
					your calendar, read a document, or update a spreadsheet.
				</li>
				<li>
					Actions that cannot be undone, such as sending an email, sharing a
					file, or deleting something, ask for your approval before they run.
				</li>
				<li>
					The Solus app on your device talks to Google directly. The results
					go to the AI coding assistant you chose (Claude Code by Anthropic or
					Codex by OpenAI) as part of that conversation, and that service
					processes them under its own privacy policy.
				</li>
				<li>
					Solus's servers do not receive, store, or read the content of your
					Google data.
				</li>
			</ul>
			<h3 class="text-[15px] font-semibold text-[#1A1714] mb-2">
				What Solus never does with it
			</h3>
			<ul class="list-disc pl-5 flex flex-col gap-2 mb-4">
				<li>
					Use it to develop, improve, or train artificial intelligence or
					machine learning models.
				</li>
				<li>Sell it, or use or transfer it for advertising.</li>
				<li>
					Let people read it, unless you ask us to, it is needed for security,
					or the law requires it.
				</li>
			</ul>
			<h3 class="text-[15px] font-semibold text-[#1A1714] mb-2">
				Where your Google sign-in is kept
			</h3>
			<p class="mb-4">
				The access token Google gives Solus is stored on your device, in your
				operating system's secure credential store, and never in plain text.
				If you sign in to a Solus account and turn on sync, a connection can
				instead be kept encrypted in your Solus account so that your other
				devices can use it. Only the token is kept there, never the content of
				your Google data.
			</p>
			<h3 class="text-[15px] font-semibold text-[#1A1714] mb-2">
				Removing access
			</h3>
			<p class="mb-4">
				To disconnect a Google product, go to
				<strong class="text-[#1A1714] font-medium">Settings → MCP</strong> and
				choose <strong class="text-[#1A1714] font-medium">Disconnect</strong>.
				Solus then deletes its token for that product. To remove Solus's
				access to your Google account completely, remove Solus at
				<a
					href="https://myaccount.google.com/connections"
					target="_blank"
					rel="noopener noreferrer"
					class="text-[#1A1714] underline underline-offset-2 hover:text-[#A09488] transition-colors"
					>myaccount.google.com/connections</a
				>.
			</p>
			<h3 class="text-[15px] font-semibold text-[#1A1714] mb-2">
				Limited Use
			</h3>
			<p>
				Solus's use and transfer of information received from Google APIs to
				any other app will adhere to the
				<a
					href="https://developers.google.com/terms/api-services-user-data-policy"
					target="_blank"
					rel="noopener noreferrer"
					class="text-[#1A1714] underline underline-offset-2 hover:text-[#A09488] transition-colors"
					>Google API Services User Data Policy</a
				>, including the Limited Use requirements.
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
	</div>
</main>
