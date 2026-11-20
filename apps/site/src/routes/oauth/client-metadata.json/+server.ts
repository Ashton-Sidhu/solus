import type { RequestHandler } from './$types';
// The one source of the document, in the contracts the Solus host reads
// (packages/contracts/src/integrations/client-metadata-document.ts).
import document from '../../../../../../packages/contracts/src/integrations/solus-client-metadata.json';

// Solus's OAuth Client ID Metadata Document. Its URL is Solus's `client_id` at
// every authorization server that supports these documents, so this path must
// not move. Served by the Worker, not as a prerendered file, so it carries its
// own cache header: authorization servers cache it for an hour.
export const prerender = false;

export const GET: RequestHandler = () =>
	new Response(JSON.stringify(document, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=3600'
		}
	});
