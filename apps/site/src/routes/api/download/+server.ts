import type { RequestHandler } from './$types';
import { DOWNLOADS, isDownloadPlatform } from '$lib/download';

// Streams the latest desktop build for one platform from the releases bucket.
// `?platform=windows` or `?platform=linux`; no platform means macOS, as the
// links published before Windows and Linux did.
export const GET: RequestHandler = async ({ platform, url }) => {
	const bucket = platform?.env?.RELEASES_BUCKET;
	if (!bucket) {
		return new Response('Storage not configured', { status: 503 });
	}

	const requested = url.searchParams.get('platform') ?? 'mac';
	if (!isDownloadPlatform(requested)) {
		return new Response('Unknown platform', { status: 400 });
	}
	const { filename } = DOWNLOADS[requested];

	const object = await bucket.get(filename);
	if (!object) {
		return new Response('File not found', { status: 404 });
	}

	return new Response(object.body, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Content-Length': object.size.toString(),
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
