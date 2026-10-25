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

/** Installs the standalone server and starts its service; `install.sh` supports macOS and Linux. */
export const SERVER_COMMAND =
	"curl -fsSL https://github.com/Ashton-Sidhu/solus/releases/latest/download/install.sh | sh -s -- --setup";

/** Where the server command runs for each visitor. Windows has no server build, so it runs in WSL or on a Linux machine. */
export const SERVER_TARGETS: Record<DownloadPlatform, string> = {
	mac: "Server on this Mac",
	linux: "Server on this machine",
	windows: "Server in WSL or on Linux",
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
