import { sourceControlWritingOptions } from "@solus/client-core/settings-source-control";
import { settingsDefinitions } from "@solus/client-core/settings-definitions";
import type { SettingCopy } from "@solus/client-core/settings-search";

/** Search data is shared by the navigation and section rows without loading the section components. */
export interface SettingItem extends SettingCopy {
  id: string
  keywords: string[]
}

export const chatSettings = [
  {
    id: "auto-open-artifacts",
    ...settingsDefinitions["chat.auto-open-artifacts"],
    keywords: ["pane", "output"],
  },
  {
    id: "artifact-chip-size",
    ...settingsDefinitions["chat.artifact-chip-size"],
    keywords: ["artifacts", "chips", "links", "works", "pull request", "larger", "smaller"],
  },
  {
    id: "response-streaming",
    ...settingsDefinitions["chat.response-streaming"],
    keywords: ["buffered", "text"],
  },
  {
    id: "turn-diff-summary",
    ...settingsDefinitions["chat.turn-diff-summary"],
    keywords: ["transcript"],
  },
  {
    id: "keep-turn-diff-summary",
    ...settingsDefinitions["chat.keep-turn-diff-summary"],
    keywords: ["diff", "history"],
  },
  {
    id: "hide-server-background-work",
    ...settingsDefinitions["chat.hide-server-background-work"],
    keywords: ["running in the background", "dev server", "port", "stop"],
  },
  {
    id: "show-tool-calls",
    ...settingsDefinitions["chat.show-tool-calls"],
    keywords: ["steps", "activity", "transcript", "simple", "hide"],
  },
  {
    id: "collapse-composer",
    ...settingsDefinitions["chat.collapse-composer"],
    keywords: ["composer", "compact", "minimize"],
  },
];

export const sessionSettings = [
  {
    id: "agent-model",
    ...settingsDefinitions["sessions.agent-model"],
    keywords: ["agent", "claude", "codex", "opus", "sonnet", "haiku", "gpt", "ai", "auto"],
  },
  {
    id: "default-permission",
    ...settingsDefinitions["sessions.default-permission"],
    keywords: ["supervised", "ask", "edits", "auto", "full", "access", "plan"],
  },
  {
    id: "ratelimit",
    ...settingsDefinitions["sessions.rate-limit-behavior"],
    keywords: ["queue", "throttle"],
  },
  {
    id: "completed-retention",
    ...settingsDefinitions["sessions.completed-retention"],
    keywords: ["done", "retention", "history", "shelf", "sidebar", "settled"],
  },
  {
    id: "model-routing",
    ...settingsDefinitions["sessions.section-model-routing"],
    keywords: ["auto", "jev", "interface", "exploration", "task", "general"],
  },
  {
    id: "worker-model",
    ...settingsDefinitions["sessions.worker-model"],
    keywords: ["delegate", "routing", "route", "orchestration", "orchestrator", "agent", "reasoning", "effort"],
  },
  {
    id: "fallback-model",
    ...settingsDefinitions["sessions.fallback-model"],
    keywords: ["delegate", "usage", "limit", "rate limit", "spent", "quota", "backup", "worker"],
  },
  {
    id: "delegation-instructions",
    ...settingsDefinitions["sessions.delegation-instructions"],
    keywords: ["delegate", "delegating", "orchestration", "orchestrator", "workers", "routing", "route", "prompt"],
  },
];

export const generalSettings = [
  {
    id: "text-generation-model",
    ...settingsDefinitions["general.text-generation-model"],
    keywords: ["metadata"],
  },
  {
    id: "projects-base",
    ...settingsDefinitions["general.projects-base"],
    keywords: ["directory", "base", "start", "open", "picker", "path"],
  },
  {
    id: "auto-rename",
    ...settingsDefinitions["general.auto-rename"],
    keywords: ["rename", "title", "tab"],
  },
  { id: "code-editor", ...settingsDefinitions["general.code-editor"], keywords: ["vscode", "ide", "applications"] },
  { id: "terminal", ...settingsDefinitions["general.fallback-terminal"], keywords: ["shell", "command", "console", "tmux", "applications"] },
  {
    id: "about",
    ...settingsDefinitions["general.section-about-solus"],
    keywords: ["version", "update", "upgrade", "release", "notes", "restart"],
  },
];

/** Search words, read by the settings page to find this page from any other. */

export const appearanceSettings: SettingItem[] = [
  {
    id: "theme",
    ...settingsDefinitions["appearance.section-theme"],
    keywords: ["dark", "light", "appearance", "mode", "system"],
  },
  {
    id: "custom-css",
    ...settingsDefinitions["appearance.custom-css"],
    keywords: ["theme", "css", "style", "colors", "custom", "restyle"],
  },
  {
    id: "font-family",
    ...settingsDefinitions["appearance.font-family"],
    keywords: ["family", "typeface", "dm sans", "system", "geist", "lora", "serif"],
  },
  { id: "font-size", ...settingsDefinitions["appearance.font-family"], keywords: ["size", "text", "zoom"] },
  {
    id: "conversation-width",
    ...settingsDefinitions["appearance.conversation-width"],
    keywords: ["chat", "transcript", "column", "full", "layout"],
  },
  {
    id: "sidebar-view",
    ...settingsDefinitions["appearance.sidebar-view"],
    keywords: ["projects", "working"],
  },
  {
    id: "sky-scene",
    ...settingsDefinitions["appearance.sky-scene"],
    keywords: ["sky", "dawn", "dusk", "night", "sunset", "sunrise", "header", "decoration"],
  },
  {
    id: "sidebar-sky",
    ...settingsDefinitions["appearance.sidebar-sky"],
    keywords: ["header", "art", "decoration", "gradient", "stars"],
  },
  {
    id: "draft-mark",
    ...settingsDefinitions["appearance.draft-mark"],
    keywords: ["logo", "halftone", "draft", "composer", "background", "decoration"],
  },
  {
    id: "sidebar-places",
    ...settingsDefinitions["appearance.sidebar-places"],
    keywords: ["places", "column", "pin", "apps", "hide", "order", "reorder", "workspace", "automations", "insights", "tasks"],
  },
  {
    id: "sidebar-motion",
    ...settingsDefinitions["appearance.sidebar-motion"],
    keywords: ["motion", "speed", "duration", "slide", "fade", "ms"],
  },
  {
    id: "project-panel-items",
    ...settingsDefinitions["appearance.project-panel-items"],
    keywords: ["rail", "hide", "environment", "git", "goal", "agents", "webhooks", "terminal", "usage", "browser"],
  },
  {
    id: "reply-opacity",
    ...settingsDefinitions["appearance.reply-opacity"],
    keywords: ["assistant", "message", "contrast", "fade", "transcript"],
  },
  {
    id: "font-smoothing",
    ...settingsDefinitions["appearance.font-smoothing"],
    keywords: ["antialiased"],
  },
  {
    id: "prompt-font-family",
    ...settingsDefinitions["appearance.prompt-font-family"],
    keywords: ["composer", "input", "draft", "family", "typeface"],
  },
  {
    id: "prompt-font-size",
    ...settingsDefinitions["appearance.prompt-font-family"],
    keywords: ["composer", "input", "draft", "size"],
  },
  {
    id: "document-font-family",
    ...settingsDefinitions["appearance.document-font-family"],
    keywords: ["family", "typeface", "writing", "prose"],
  },
  {
    id: "document-font-size",
    ...settingsDefinitions["appearance.document-font-family"],
    keywords: ["size", "writing", "prose"],
  },
  {
    id: "code-font-family",
    ...settingsDefinitions["appearance.code-font-family"],
    keywords: ["mono", "monospace", "typeface", "sf mono", "geist", "fira", "jetbrains", "cascadia"],
  },
  {
    id: "code-font-size",
    ...settingsDefinitions["appearance.code-font-family"],
    keywords: ["size", "mono"],
  },
  {
    id: "installed-fonts",
    ...settingsDefinitions["appearance.section-installed-fonts"],
    keywords: ["typeface", "override", "local"],
  },
];

/** Search words, read by the settings page to find this page from any other. */

export const reviewSettings: SettingItem[] = [
  { id: "review-generate-on-open", ...settingsDefinitions["review.review-generate-on-open"], keywords: ["automatic"] },
  { id: "review-warming", ...settingsDefinitions["review.review-warming"], keywords: ["background", "prefetch"] },
  { id: "review-agent", ...settingsDefinitions["review.review-agent"], keywords: ["code review", "backend", "claude", "codex"] },
  { id: "review-model", ...settingsDefinitions["review.review-model"], keywords: ["code review", "llm"] },
  { id: "review-reasoning", ...settingsDefinitions["review.review-reasoning"], keywords: ["thinking", "code review"] },
  { id: "review-instructions", ...settingsDefinitions["review.review-instructions"], keywords: ["prompt", "custom"] },
  { id: "review-lenses", ...settingsDefinitions["review.review-lenses"], keywords: ["review", "artifact", "visualize", "custom"] },
];

/** Search words, read by the settings page to find this page from any other. */

export const toolSettings: SettingItem[] = [
  { id: "code-intel", ...settingsDefinitions["tools.section-code-intelligence"], keywords: ["scip", "index", "definition", "references", "symbol", "navigation", "typescript", "python", "go", "rust"] },
  { id: "typesafe", ...settingsDefinitions["tools.section-typesafe"], keywords: ["auto", "model", "api", "key", "credential"] },
];

/** Search words, read by the settings page to find this page from any other. */
export const experimentalSettings = [
  { id: "auto-voice", ...settingsDefinitions["experimental.auto-voice"], keywords: ["dictation", "automatic", "listen", "beta"] },
];

/** Search words, read by the settings page to find this page from any other. */
export const telemetrySettings = [
  { id: "export", ...settingsDefinitions["telemetry.export"], keywords: ["otel", "opentelemetry", "otlp", "enable", "collector"] },
  { id: "endpoint", ...settingsDefinitions["telemetry.endpoint"], keywords: ["otel", "headers", "auth", "token", "api key"] },
  { id: "metrics", ...settingsDefinitions["telemetry.signals-metrics"], keywords: ["otel", "otlp", "signal"] },
  { id: "signals", ...settingsDefinitions["telemetry.signals"], keywords: ["otel", "otlp", "metrics", "signal"] },
];

/** Search words, read by the settings page through the Host page. */
export const webhookHostSearchWords = ["webhook", "public url", "hold", "offline", "reverse proxy", "ngrok"];

/** Search words, read by the settings page to find this page from any other. */
export const accountSearchWords = ["account", "sync", "personal", "cloud", "sign", "devices", "conflict", "clear", "link", "computer", "hosts", "profile", "copy", "address", "self-hosted"];

/** Search words, read by the settings page to find this page from any other. */
export const agentProfileSearchWords = ["agent profile", "profile", "instructions", "extra", "system prompt", "custom", "subagents", "commands", "prompts", "skills", "mcp", "servers", "conflict"];

/** Search words, read by the settings page to find this page from any other. */
export const organizationSearchWords = ["organization", "owner", "member", "members", "invite", "role", "rename", "cloud hosts", "personal hosts", "packages", "setup script", "leave", "projects", "repositories"];

/** Search words, read by the settings page to find this page from any other. */
export const mcpSearchWords = ["mcp", "server", "catalog", "integrations.sh", "remote tools", "connector"];

/** Search words for the Retention group on the Host page. */
export const retentionSearchWords = ["automation", "archived", "recording", "video", "delete", "retention", "days", "history"];
/** Search words, read by the settings page through the Host page. */
export const appHostSearchWords = ["app", "published", "publish", "tailscale", "tailnet", "auth key"];
/** Search words, read by the settings page to find this page from any other. */
export const hostSearchWords = [...retentionSearchWords, ...webhookHostSearchWords, ...appHostSearchWords];

/** Search words, read by the settings page to find this page from any other. */
export const analyticsSearchWords = ["analytics", "telemetry", "tracking", "privacy", "data", "consent", "usage"];

/** Search words, read by the settings page to find this page from any other. */
export const policySearchWords = ["policy", "managed", "mdm", "lock", "permission", "limit", "insights", "host policy", "export", "import", "mobileconfig", "registry"];

/** Search words, read by the settings page to find this page from any other. */
export const webhooksSearchWords = ["webhook", "hook", "github", "sender", "delivery", "deliveries", "url", "trigger", "event", "organization", "admin"];

/** Search words, read by the settings page to find the Codebases page from any other. */
export const codebasesSearchWords = ["codebase", "codebases", "folder", "folders", "repository", "repositories", "multi-repo", "monorepo", "workspace", "code-workspace", "root", "codebase names", "naming"];

export const sourceControlSettings: SettingItem[] = [
  { id: "github", ...settingsDefinitions["source-control.github"], keywords: [] },
  { id: "writing", ...settingsDefinitions["source-control.commit-and-pull-request-writing"], keywords: ["commit message", "pr description", "merge request", ...Object.values(sourceControlWritingOptions).flatMap((option) => [option.label, option.description])] },
  { id: "templates", ...settingsDefinitions["source-control.follow-pull-request-templates"], keywords: [] },
  { id: "writer-model", ...settingsDefinitions["source-control.source-control-writer-model"], keywords: [] },
  { id: "branch-names", ...settingsDefinitions["source-control.branch-names"], keywords: ["worktree", "branch naming"] },
  { id: "project-branch-names", ...settingsDefinitions["source-control.override-branch-names"], keywords: ["worktree"] },
  { id: "project-codebase-names", ...settingsDefinitions["source-control.override-codebase-names"], keywords: ["codebase", "naming"] },
  { id: "copied-files", ...settingsDefinitions["source-control.files-copied-to-other-hosts"], keywords: [] },
];

/** The same row definitions drive page search and row visibility. */
export const settingsByPage = {
  "source-control": sourceControlSettings,
  chat: chatSettings,
  sessions: sessionSettings,
  general: generalSettings,
  appearance: appearanceSettings,
  review: reviewSettings,
  tools: toolSettings,
  experimental: experimentalSettings,
  telemetry: telemetrySettings,
} satisfies Record<string, readonly SettingItem[]>;
