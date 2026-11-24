import { githubSetting } from './settings-source-control'
import type { SettingCopy } from './settings-search'

/** Display text shared by settings pages and search. No page UI is loaded to search it. */
export const settingsDefinitions = {
  "chat.section-conversation": {
    label: "Conversation",
  },
  "chat.response-streaming": {
    label: "Response streaming",
    description: "Show paragraphs and code blocks as they finish, or wait for each segment.",
  },
  "chat.turn-diff-summary": {
    label: "Show changed files after turns",
    description: "Show a diff summary after each turn.",
  },
  "chat.keep-turn-diff-summary": {
    label: "Keep changed files on earlier turns",
    description: "Off shows the summary for the latest turn only.",
  },
  "chat.auto-open-artifacts": {
    label: "Open artifacts automatically",
    description: "Open Threads beside the conversation when new artifacts arrive.",
  },
  "chat.artifact-chip-size": {
    label: "Artifact chip size",
    description: "The size of the chips under a reply that open what the turn made.",
  },
  "chat.show-tool-calls": {
    label: "Show tool calls",
    description: "Off shows only the agent's messages, questions, and cards.",
  },
  "chat.collapse-composer": {
    label: "Collapse the input bar when idle",
    description: "Hide the toolbar until the input bar has focus.",
  },
  "general.section-workspace": {
    label: "Workspace",
  },
  "general.projects-base": {
    label: "Projects folder",
    description: "Where new projects are created and clones land.",
  },
  "general.text-generation-model": {
    label: "Text-generation model",
    description: "Session names and short background writing for your work.",
  },
  "general.section-about-solus": {
    label: "About Solus",
  },
  "general.version": {
    label: "Version",
  },
  "general.coding-providers": {
    label: "Coding providers",
  },
  "general.download-updates-automatically": {
    label: "Download updates automatically",
    description: "Download updates when found. You choose when to restart.",
  },
  "sessions.section-new-sessions": {
    label: "New sessions",
  },
  "sessions.agent-model": {
    label: "Default provider",
    description: "Provider for new sessions. Set each provider's model in Providers.",
  },
  "sessions.default-permission": {
    label: "Default permission mode",
    description: "Mode for new sessions. Existing sessions keep theirs.",
  },
  "sessions.section-sessions": {
    label: "Sessions",
  },
  "sessions.auto-rename": {
    label: "Name sessions automatically",
    description: "Summarize the first prompt into a short session name.",
  },
  "sessions.section-delegation": {
    label: "Delegation",
  },
  "sessions.worker-model": {
    label: "Default worker model",
    description: "Used when a parent starts a child session without a provider or model.",
  },
  "sessions.fallback-model": {
    label: "Fallback model",
    description: "New sessions that an agent starts with no model use it while the default provider is out of usage.",
  },
  "sessions.delegation-instructions": {
    label: "Delegation instructions",
    description: "Extra guidance for agents when they delegate work.",
  },
  "sessions.rate-limit-behavior": {
    label: "Rate limit behavior",
    description: "What your runs do when they hit a provider rate limit, on every host.",
  },
  "sessions.section-model-routing": {
    label: "Model routing",
  },
  "sessions.typesafe-key-required": {
    label: "TypeSafe key required",
    description: "Needs a TypeSafe key. Until then, Auto uses General use.",
  },
  "tasks.section-task-behavior": {
    label: "Task behavior",
  },
  "tasks.task-lifecycle": {
    label: "Task lifecycle control",
    description: "None: no changes. Moderate: Done is yours. Autonomous: full control.",
  },
  "tasks.completed-retention": {
    label: "Completed task history",
    description: "Days to keep completed tasks in the sidebar.",
  },
  "appearance.section-theme": {
    label: "Theme",
  },
  "appearance.section-layout": {
    label: "Layout",
  },
  "appearance.section-custom-theme": {
    label: "Custom theme",
  },
  "appearance.custom-css": {
    label: "Custom CSS",
    description: "CSS that restyles Solus on desktop and web. Ask an agent to write it, or paste your own. It cannot load files.",
  },
  "appearance.conversation-width": {
    label: "Conversation width",
    description: "How wide messages run in the conversation pane. Narrow panes always fill their width.",
  },
  "appearance.sidebar-view": {
    label: "Sidebar view",
    description: "Group sessions by status, or in one folder per project.",
  },
  "appearance.sidebar-places": {
    label: "Sidebar places",
    description: "The places and pinned apps in the column at the left of the sidebar, and their order. Right-click the column to change them there.",
  },
  "appearance.sidebar-motion": {
    label: "Sidebar animation",
    description: "Sidebar task animation length. 0 turns it off.",
  },
  "appearance.project-panel-items": {
    label: "Project panel",
    description: "The sections the project panel shows, and the rows in each. Right-click the panel to change them there.",
  },
  "appearance.section-sky": {
    label: "Sky",
  },
  "appearance.sky-scene": {
    label: "Scene",
    description: "Time of day changes the scene at 05:00, 09:00, 17:00, and 21:00 on this device's clock. Or keep one scene.",
  },
  "appearance.sidebar-sky": {
    label: "Sky in the sidebar",
    description: "The picture behind the title bar of the session sidebar.",
  },
  "appearance.draft-mark": {
    label: "Mark on the new-tab home",
    description: "The Solus mark in dots behind the input bar of a new session, in the colours of the scene.",
  },
  "appearance.section-typography": {
    label: "Typography",
  },
  "appearance.font-family": {
    label: "Interface font",
    description: "Everything outside code blocks and diffs.",
  },
  "appearance.prompt-font-family": {
    label: "Prompt font",
    description: "The prompt box only. Mono works well.",
  },
  "appearance.document-font-family": {
    label: "Document font",
    description: "Document and plan editors.",
  },
  "appearance.code-font-family": {
    label: "Code font",
    description: "Diffs and code blocks.",
  },
  "appearance.reply-opacity": {
    label: "Reply text opacity",
    description: "How strong the agent's reply text reads. Headings stay at full strength.",
  },
  "appearance.font-smoothing": {
    label: "Font smoothing",
    description: "Thinner grayscale smoothing than the macOS default.",
  },
  "appearance.section-installed-fonts": {
    label: "Installed fonts",
    description: "A font installed on this device stays here. Other devices keep your synced choice.",
  },
  "review.section-automation": {
    label: "Automation",
  },
  "review.review-generate-on-open": {
    label: "Generate PR guides on open",
    description: "Run the review agent when an opened PR has no cached guide.",
  },
  "review.review-warming": {
    label: "Warm review guides",
    description: "Prepare guides and worktrees for top PRs.",
  },
  "review.section-model": {
    label: "Model",
  },
  "review.review-agent": {
    label: "Review companion agent",
    description: "Agent that reviews the diff.",
  },
  "review.review-model": {
    label: "Review companion model",
    description: "Model the review agent uses.",
  },
  "review.review-reasoning": {
    label: "Review companion reasoning",
    description: "Reasoning effort the review agent uses.",
  },
  "review.section-customization": {
    label: "Customization",
  },
  "review.review-instructions": {
    label: "Review guide instructions",
    description: "Added to every review guide, with any skill instructions.",
  },
  "review.section-lenses": {
    label: "Lenses",
  },
  "review.review-lenses": {
    label: "Saved lenses",
    description: "Prompts for the Lens tab. Choose one for an HTML view of the change, or tick up to four for one lens with a tab for each.",
  },
  "tools.section-applications": {
    label: "Applications",
  },
  "tools.code-editor": {
    label: "Code editor",
    description: "Where “Open in editor” sends files.",
  },
  "tools.fallback-terminal": {
    label: "Fallback terminal",
  },
  "tools.section-code-intelligence": {
    label: "Code intelligence",
  },
  "tools.section-typesafe": {
    label: "TypeSafe",
  },
  "tools.api-key": {
    label: "API key",
  },
  "experimental.section-voice": {
    label: "Voice",
  },
  "experimental.auto-voice": {
    label: "Auto voice mode",
  },
  "telemetry.section-opentelemetry": {
    label: "OpenTelemetry",
  },
  "telemetry.export": {
    label: "Export telemetry",
  },
  "telemetry.endpoint": {
    label: "Collector endpoint",
    description: "Root OTLP/HTTP URL, such as https://otlp.example.com. Solus adds /v1/traces.",
  },
  "telemetry.section-signals": {
    label: "Signals",
  },
  "telemetry.signals": {
    label: "Traces and logs",
    description: "All spans and structured logs. Same trace ids as Insights.",
  },
  "telemetry.signals-metrics": {
    label: "Metrics",
    description: "Duration histograms recorded by timed operations.",
  },
  "telemetry.section-usage-analytics": {
    label: "Usage analytics",
  },
  "telemetry.share-anonymous-analytics-from-this-device": {
    label: "Share anonymous analytics from this device",
  },
  "source-control.section-project-worktrees": {
    label: "Project worktrees",
    description: "Project branch names override your personal default. Copied files belong to this project.",
  },
  "source-control.section-source-control-providers": {
    label: "Source control providers",
  },
  "source-control.github": githubSetting,
  "source-control.section-commits-pull-requests": {
    label: "Commits & pull requests",
  },
  "source-control.commit-and-pull-request-writing": {
    label: "Commit and pull request writing",
  },
  "source-control.follow-pull-request-templates": {
    label: "Follow pull-request templates",
    description: "Use the repository's PR template when there is one.",
  },
  "source-control.source-control-writer-model": {
    label: "Source-control writer model",
    description: "Model for commits, PRs, and branch names. Off uses the text-generation model.",
  },
  "source-control.section-worktrees": {
    label: "Worktrees",
  },
  "source-control.branch-names": {
    label: "Branch names",
  },
  "source-control.override-branch-names": {
    label: "Override branch names",
    description: "Use a different naming for this project. Saved in .solus/config.json, so you can commit it.",
  },
  "source-control.project-branch-names": {
    label: "Project branch names",
  },
  "source-control.override-codebase-names": {
    label: "Codebase names for this project",
    description: "How Solus names a codebase that it forms from this project and a second one. Saved in .solus/config.json, so you can commit it.",
  },
  "codebases.codebase-names": {
    label: "Codebase names",
  },
  "source-control.files-copied-to-other-hosts": {
    label: "Files copied to other hosts",
    description: "Run on copies the ignored files that .worktreeinclude names, like .env, into a clone on another host.",
  },
  "account.section-account": {
    label: "Account",
  },
  "account.not-signed-in": {
    label: "Not signed in",
    description: "Your settings and your agent profile stay on this device. Sign in to Solus to sync them between your devices and the hosts you work on.",
  },
  "account.section-sync": {
    label: "Sync",
    description: "Your settings and your agent profile sync through your account. Device settings, host settings, and credentials never sync.",
  },
  "account.settings-and-agent-profile": {
    label: "Settings and agent profile",
  },
  "account.section-reset-sync": {
    label: "Reset sync",
    description: "Clearing deletes the copy in your account and starts it again from this device. Do this only when the synced copy is wrong.",
  },
  "account.synced-settings": {
    label: "Synced settings",
    description: "Your other devices take the new copy.",
  },
  "account.synced-agent-profile": {
    label: "Synced agent profile",
  },
  "organization.section-organization": {
    label: "Organization",
  },
  "organization.policy": {
    label: "Policy",
    description: "Insights, limits, and locked settings of each organization's work.",
  },
  "voice.section-dictation": {
    label: "Dictation",
  },
  "voice.auto-send-transcripts": {
    label: "Auto-send transcripts",
    description: "Send voice messages when transcribed, not just fill the composer.",
  },
  "voice.silence-threshold": {
    label: "Silence threshold",
    description: "Wait after you stop speaking before sending.",
  },
  "voice.section-model": {
    label: "Model",
  },
  "voice.voice-model": {
    label: "Voice model",
  },
  "voice.section-custom-dictionary": {
    label: "Custom dictionary",
    description: "Fix how dictation spells a word. Under Heard as, add what it writes instead.",
  },
  "integrations.section-connections": {
    label: "Connections",
  },
  "integrations.github": githubSetting,
  "integrations.google-drive": {
    label: "Google Drive",
  },
  "integrations.atlassian": {
    label: "Atlassian",
  },
  "integrations.linear": {
    label: "Linear",
  },
  "providers.section-instance": {
    label: "Instance",
  },
  "providers.display-name": {
    label: "Display name",
  },
  "providers.enabled": {
    label: "Enabled",
    description: "A disabled instance refuses new turns. Running turns can finish.",
  },
  "providers.section-runtime": {
    label: "Runtime",
  },
  "providers.binary-path": {
    label: "Binary path",
    description: "Executable name or absolute path on this host. Leave empty to use the installed CLI.",
  },
  "providers.shadow-home-path": {
    label: "Shadow home path",
    description: "Separate auth.json while sharing configuration, sessions, and skills from CODEX_HOME.",
  },
  "providers.idle-compaction": {
    label: "Idle compaction",
    description: "Ask before compacting an old session when you return, or keep the full history.",
  },
  "providers.auto-compact-after": {
    label: "Auto-compact after",
    description: "Compact after 100,000 to 1,000,000 tokens. Leave empty for Claude's default.",
  },
  "providers.launch-arguments": {
    label: "Launch arguments",
    description: "One literal CLI argument per row. Arguments are passed directly, without a shell.",
  },
  "providers.section-environment": {
    label: "Environment",
  },
  "providers.variables": {
    label: "Variables",
    description: "Private CLI settings, API keys, and base URLs. Saved sensitive values are never returned to clients.",
  },
  "providers.section-models": {
    label: "Models",
    description: "Choose the models in the model picker, their order, and which ones sit under Legacy models. Add a custom model ID for a gateway, proxy, or cloud model that is not in the list.",
  },
  "providers.section-status-and-account": {
    label: "Status and account",
  },
  "providers.status": {
    label: "Status",
  },
  "providers.account": {
    label: "Account",
    description: "The provider CLI saves its login in this instance's home on the host.",
  },
  "providers.saved-model-unavailable": {
    label: "Saved model unavailable",
    description: "Your choice stays saved. New sessions use the built-in default until you choose an available model.",
  },
  "providers.reasoning": {
    label: "Reasoning",
    description: "Reasoning level for this model in new sessions.",
  },
  "providers.context-window": {
    label: "Context window",
    description: "Maximum context for this model in new sessions.",
  },
  "providers.fast-mode": {
    label: "Fast mode",
    description: "Use the provider's fast service for this model. Provider charges can be higher.",
  },
  "providers.model-instructions": {
    label: "Model instructions",
    description: "Added whenever this model runs, including existing sessions.",
  },
  "providers.reset-model-options": {
    label: "Reset model options",
    description: "Use this model's built-in reasoning, context window, and speed.",
  },
  "providers.automatic-model-selection": {
    label: "Automatic model selection",
    description: "Auto selects a model from the first prompt and uses routing options. Configure Auto in Sessions. A TypeSafe key is required on the run host.",
  },
  "providers.section-advanced-provider-settings": {
    label: "Advanced provider settings",
  },
  "providers.status-check-interval": {
    label: "Status check interval",
    description: "Seconds between status checks while a provider detail page is open. Set 0 to disable repeated checks.",
  },
  "providers.default-idle-compaction": {
    label: "Default idle compaction",
    description: "Claude can ask to compact an old session when you return. Each Claude instance can override this choice.",
  },
  "providers.model-list": {
    label: "Model list",
  },
  "mcp.section-installed": {
    label: "Installed",
  },
  "mcp.section-connect-by-address": {
    label: "Connect by address",
  },
  "mcp.section-found": {
    label: "On your hosts",
  },
  "host.section-retention": {
    label: "Retention",
  },
  "host.delete-archived-automations-after": {
    label: "Delete archived automations after",
    description: "Days to keep archived automations and their runs. Conversations are kept.",
  },
  "host.delete-unfiled-recordings-after": {
    label: "Delete unfiled recordings after",
    description: "Days to keep a browser recording that is not filed on a task or pull request, or sent to an agent.",
  },
} satisfies Record<string, SettingCopy>
