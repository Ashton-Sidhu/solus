export const DOWNLOAD_PATH = "/api/download";
export const DOWNLOAD_FILENAME = "Solus-latest-arm64.dmg";
export const BREW_COMMAND = "brew install --cask Ashton-Sidhu/tap/solus";

export function downloadApp(event?: Event) {
	event?.preventDefault();
	const link = document.createElement("a");
	link.href = DOWNLOAD_PATH;
	link.download = DOWNLOAD_FILENAME;
	document.body.appendChild(link);
	link.click();
	link.remove();
}
