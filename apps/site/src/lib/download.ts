export type DownloadPlatform = "mac" | "windows" | "linux";

/**
 * The latest desktop build for each platform: its object in the releases
 * bucket, which is also the file name the visitor saves, and the page route
 * that streams it (`routes/api/download`).
 */
export const DOWNLOADS: Record<DownloadPlatform, { name: string; filename: string; path: string }> = {
	mac: { name: "macOS", filename: "Solus-latest-arm64.dmg", path: "/api/download" },
	windows: { name: "Windows", filename: "Solus-latest-x64.exe", path: "/api/download?platform=windows" },
	linux: { name: "Linux", filename: "Solus-latest-x86_64.AppImage", path: "/api/download?platform=linux" },
};

export const BREW_COMMAND = "brew install --cask Ashton-Sidhu/tap/solus";

const SERVER_RELEASE = "https://github.com/Ashton-Sidhu/solus/releases/latest/download";

/**
 * Installs the standalone server and starts its service: `install.sh` on macOS
 * and Linux, `install.ps1` (Windows PowerShell 5.1, x64) on Windows. `prompt`
 * and `label` are the short form the pill shows; `command` is what it copies.
 */
export const SERVER_COMMANDS = {
	mac: { command: `curl -fsSL ${SERVER_RELEASE}/install.sh | sh -s -- --setup`, prompt: "$", label: "curl -fsSL …/install.sh | sh" },
	linux: { command: `curl -fsSL ${SERVER_RELEASE}/install.sh | sh -s -- --setup`, prompt: "$", label: "curl -fsSL …/install.sh | sh" },
	windows: {
		command: `& ([scriptblock]::Create((irm ${SERVER_RELEASE}/install.ps1))) -Setup`,
		prompt: "PS>",
		label: "irm …/install.ps1 | iex",
	},
} satisfies Record<DownloadPlatform, { command: string; prompt: string; label: string }>;

/** Where the server command runs for each visitor. */
export const SERVER_TARGETS: Record<DownloadPlatform, string> = {
	mac: "Server on this Mac",
	linux: "Server on this machine",
	windows: "Server on this PC",
};

export function isDownloadPlatform(value: string): value is DownloadPlatform {
	return value in DOWNLOADS;
}

/** The visitor's desktop platform, read in the browser. Phones and unknown systems get macOS. */
export function detectPlatform(): DownloadPlatform {
	const agent = navigator as Navigator & { userAgentData?: { platform?: string } };
	const name = `${agent.userAgentData?.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
	if (/android|iphone|ipad/.test(name)) return "mac";
	if (name.includes("win")) return "windows";
	if (name.includes("linux") || name.includes("x11") || name.includes("cros")) return "linux";
	return "mac";
}

export function downloadApp(platform: DownloadPlatform = "mac") {
	const link = document.createElement("a");
	link.href = DOWNLOADS[platform].path;
	link.download = DOWNLOADS[platform].filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
}
