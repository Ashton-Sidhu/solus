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

/** A Linux machine with no desktop runs the standalone server; this installs it and starts its service. */
export const LINUX_SERVER_COMMAND =
	"curl -fsSL https://github.com/Ashton-Sidhu/solus/releases/latest/download/install.sh | sh -s -- --setup";

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
