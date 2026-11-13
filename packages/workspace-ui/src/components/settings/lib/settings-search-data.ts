/** Search data is shared by the navigation and section rows without loading the section components. */
export interface SettingItem {
  id: string
  keywords: string[]
}

export const chatSettings = [
  {
    id: "response-streaming",
    keywords: ["response", "streaming", "paragraph", "buffered", "text"],
  },
  {
    id: "turn-diff-summary",
    keywords: ["diff", "summary", "changed", "files", "turn", "transcript"],
  },
  {
    id: "keep-turn-diff-summary",
    keywords: ["diff", "summary", "changed", "files", "turn", "earlier", "keep", "history"],
  },
  {
    id: "show-tool-calls",
    keywords: ["tool", "calls", "steps", "activity", "transcript", "simple", "hide"],
  },
  {
    id: "collapse-composer",
    keywords: [
      "collapse",
      "composer",
      "input",
      "bar",
      "toolbar",
      "focus",
      "idle",
      "compact",
      "minimize",
    ],
  },
];

export const sessionSettings = [
  {
    id: "agent-model",
    keywords: [
      "agent",
      "model",
      "default",
      "claude",
      "codex",
      "opus",
      "sonnet",
      "haiku",
      "gpt",
      "ai",
      "auto",
    ],
  },
  {
    id: "default-permission",
    keywords: ["default", "permission", "supervised", "ask", "edits", "auto", "full", "access", "plan", "mode"],
  },
  {
    id: "ratelimit",
    keywords: ["rate", "limit", "behavior", "queue", "throttle"],
  },
  {
    id: "auto-rename",
    keywords: [
      "rename",
      "name",
      "title",
      "session",
      "tab",
      "auto",
      "summarize",
    ],
  },
  {
    id: "model-routing",
    keywords: ["auto", "model", "routing", "jev", "interface", "exploration", "task", "general"],
  },
  {
    id: "lead-model",
    keywords: ["delegate", "delegating", "lead", "session", "orchestration", "orchestrator", "workers", "agent", "model", "reasoning", "effort", "claude", "codex"],
  },
  {
    id: "worker-model",
    keywords: ["delegate", "worker", "workers", "routing", "route", "orchestration", "orchestrator", "session", "agent", "model", "reasoning", "effort", "default"],
  },
  {
    id: "lead-instructions",
    keywords: ["delegate", "delegating", "lead", "session", "orchestration", "orchestrator", "workers", "instructions", "routing", "route", "prompt", "rules"],
  },
];

export const generalSettings = [
  {
    id: "text-generation-model",
    keywords: [
      "model",
      "text",
      "generation",
      "background",
      "session",
      "name",
      "metadata",
      "writing",
    ],
  },
  {
    id: "sidebar-motion",
    keywords: [
      "sidebar",
      "animation",
      "motion",
      "speed",
      "duration",
      "slide",
      "fade",
      "ms",
    ],
  },
  {
    id: "projects-base",
    keywords: [
      "project",
      "projects",
      "folder",
      "directory",
      "base",
      "start",
      "open",
      "picker",
      "path",
    ],
  },
  {
    id: "about",
    keywords: ["about", "version", "update", "upgrade", "release", "notes", "restart"],
  },
];

/** Search words, read by the settings page to find this page from any other. */

export const appearanceSettings: SettingItem[] = [
  {
    id: "theme",
    keywords: ["dark", "theme", "light", "appearance", "mode", "system"],
  },
  {
    id: "font-family",
    keywords: [
      "font",
      "family",
      "typeface",
      "inter",
      "dm sans",
      "system",
      "geist",
      "lora",
      "serif",
    ],
  },
  { id: "font-size", keywords: ["font", "size", "text", "zoom"] },
  {
    id: "conversation-width",
    keywords: ["conversation", "chat", "transcript", "width", "column", "wide", "narrow", "full", "layout"],
  },
  {
    id: "sidebar-view",
    keywords: ["sidebar", "view", "group", "project", "projects", "folder", "status", "working", "sessions"],
  },
  {
    id: "sky-scene",
    keywords: ["sky", "scene", "time", "day", "dawn", "dusk", "night", "sunset", "sunrise", "clock", "header", "decoration"],
  },
  {
    id: "sidebar-sky",
    keywords: ["sky", "sidebar", "header", "title", "bar", "picture", "art", "decoration", "gradient", "stars"],
  },
  {
    id: "draft-mark",
    keywords: ["mark", "logo", "dots", "halftone", "new", "tab", "home", "draft", "composer", "background", "decoration"],
  },
  {
    id: "project-panel-items",
    keywords: ["project", "panel", "rail", "show", "hide", "sections", "rows", "environment", "git", "goal", "agents", "webhooks", "terminal", "usage", "browser"],
  },
  {
    id: "reply-opacity",
    keywords: ["reply", "assistant", "message", "text", "opacity", "contrast", "fade", "transcript"],
  },
  {
    id: "font-smoothing",
    keywords: ["font", "smoothing", "antialiased", "grayscale", "thin", "macos"],
  },
  {
    id: "prompt-font-family",
    keywords: [
      "prompt",
      "composer",
      "input",
      "draft",
      "font",
      "family",
      "typeface",
      "mono",
    ],
  },
  {
    id: "prompt-font-size",
    keywords: ["prompt", "composer", "input", "draft", "font", "size"],
  },
  {
    id: "document-font-family",
    keywords: [
      "document",
      "plan",
      "editor",
      "font",
      "family",
      "typeface",
      "writing",
      "prose",
    ],
  },
  {
    id: "document-font-size",
    keywords: [
      "document",
      "plan",
      "editor",
      "font",
      "size",
      "writing",
      "prose",
    ],
  },
  {
    id: "code-font-family",
    keywords: [
      "code",
      "font",
      "mono",
      "monospace",
      "diff",
      "typeface",
      "sf mono",
      "geist",
      "fira",
      "jetbrains",
      "cascadia",
    ],
  },
  {
    id: "code-font-size",
    keywords: ["code", "font", "size", "mono", "diff"],
  },
  {
    id: "installed-fonts",
    keywords: ["font", "installed", "typeface", "override", "synced", "device", "local"],
  },
];

/** Search words, read by the settings page to find this page from any other. */

export const taskSettings: SettingItem[] = [
  {
    id: "task-lifecycle",
    keywords: ["agent", "task", "ticket", "lifecycle", "status", "done", "autonomous", "moderate"],
  },
  {
    id: "completed-retention",
    keywords: ["task", "completed", "done", "sidebar", "history", "days", "retention"],
  },
];

/** Search words, read by the settings page to find this page from any other. */

export const reviewSettings: SettingItem[] = [
  { id: "review-generate-on-open", keywords: ["review", "guide", "generate", "open", "automatic", "agent"] },
  { id: "review-warming", keywords: ["review", "guide", "warm", "background", "prefetch", "worktree"] },
  { id: "review-agent", keywords: ["review", "companion", "agent", "code review", "backend", "claude", "codex"] },
  { id: "review-model", keywords: ["review", "companion", "model", "code review", "llm"] },
  { id: "review-reasoning", keywords: ["review", "companion", "reasoning", "effort", "thinking", "code review"] },
  { id: "review-instructions", keywords: ["review", "guide", "instructions", "prompt", "custom"] },
  { id: "review-lenses", keywords: ["review", "lens", "lenses", "artifact", "html", "prompt", "visualize", "custom"] },
];

/** Search words, read by the settings page to find this page from any other. */

export const toolSettings: SettingItem[] = [
  { id: "code-editor", keywords: ["code", "editor", "vscode", "ide", "open"] },
  { id: "terminal", keywords: ["terminal", "shell", "command", "console", "tmux", "fallback"] },
  { id: "code-intel", keywords: ["code", "intelligence", "scip", "index", "definition", "references", "symbol", "navigation", "typescript", "python", "go", "rust"] },
  { id: "typesafe", keywords: ["typesafe", "auto", "model", "api", "key", "credential"] },
];

/** Search words, read by the settings page to find this page from any other. */
export const experimentalSettings = [
  { id: "auto-voice", keywords: ["voice", "dictation", "automatic", "listen", "beta"] },
];

/** Search words, read by the settings page to find this page from any other. */
export const telemetrySettings = [
  { id: "export", keywords: ["otel", "opentelemetry", "otlp", "export", "telemetry", "enable", "collector"] },
  { id: "endpoint", keywords: ["otel", "otlp", "endpoint", "url", "collector", "headers", "auth", "token", "api key"] },
  { id: "signals", keywords: ["otel", "otlp", "logs", "metrics", "traces", "spans", "signal"] },
];

/** Search words, read by the settings page through the Host page. */
export const webhookHostSearchWords = ["webhook", "public url", "hold", "offline", "reverse proxy", "ngrok"];

/** Search words, read by the settings page to find this page from any other. */
export const accountSearchWords = ["account", "sync", "personal", "cloud", "sign", "devices", "conflict", "clear", "link", "computer", "hosts", "profile", "copy"];

/** Search words, read by the settings page to find this page from any other. */
export const agentProfileSearchWords = ["agent profile", "profile", "instructions", "extra", "system prompt", "custom", "subagents", "commands", "prompts", "skills", "mcp", "servers", "conflict"];

/** Search words, read by the settings page to find this page from any other. */
export const organizationSearchWords = ["organization", "owner", "member", "projects", "repositories"];

/** Search words, read by the settings page to find this page from any other. */
export const mcpSearchWords = ["mcp", "server", "catalog", "integrations.sh", "remote tools", "connector"];

const retentionWords = ["automation", "archived", "recording", "video", "delete", "retention", "days", "history"];
/** Search words, read by the settings page to find this page from any other. */
export const hostSearchWords = [...retentionWords, ...webhookHostSearchWords];

/** Search words, read by the settings page to find this page from any other. */
export const analyticsSearchWords = ["analytics", "telemetry", "tracking", "privacy", "data", "consent", "usage"];

/** Search words, read by the settings page to find this page from any other. */
export const policySearchWords = ["policy", "managed", "mdm", "lock", "permission", "limit", "insights", "host policy", "export", "import", "mobileconfig", "registry"];

/** Search words, read by the settings page to find this page from any other. */
export const webhooksSearchWords = ["webhook", "hook", "github", "sender", "delivery", "deliveries", "url", "trigger", "event", "organization", "admin"];
