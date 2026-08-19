import type { RequestHandler } from './$types';

const OBJECT_KEY = 'Solus-latest-arm64.dmg';
const FILENAME = 'Solus-latest-arm64.dmg';

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.RELEASES_BUCKET;
	if (!bucket) {
		return new Response('Storage not configured', { status: 503 });
	}

	const object = await bucket.get(OBJECT_KEY);
	if (!object) {
		return new Response('File not found', { status: 404 });
	}

	return new Response(object.body, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${FILENAME}"`,
			'Content-Length': object.size.toString(),
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
