import { mcpAppDocument, type McpAppSnapshot } from '@solus/contracts/mcp-apps'

/**
 * The native web view's page. The app runs in an opaque-origin frame inside it.
 * Android exposes the native message bridge to nested frames too, so the outer
 * page relays only its frame's messages, signed with `secret`, which the frame
 * cannot read. A second load of the frame is a navigation: the relay stops.
 */
export function nativeMcpAppDocument(snapshot: McpAppSnapshot, secret: string): string {
  const appDocument = mcpAppDocument(snapshot.html, snapshot.csp).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>
<iframe id="app" sandbox="allow-scripts allow-forms" srcdoc="${appDocument}"></iframe>
<script>
(function () {
  var secret = ${JSON.stringify(secret)};
  var frame = document.getElementById('app');
  var loads = 0;
  var live = true;
  function relay(message) {
    message.secret = secret;
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  frame.addEventListener('load', function () {
    loads++;
    if (loads > 1 && live) {
      live = false;
      relay({ navigated: true });
    }
  });
  window.addEventListener('message', function (event) {
    if (!live || event.source !== frame.contentWindow) return;
    try {
      relay({ json: JSON.stringify(event.data) });
    } catch (_) {}
  });
  window.__solusMcpReceive = function (json) {
    if (live) frame.contentWindow.postMessage(JSON.parse(json), '*');
  };
})();
</script>`
}

/** The script that hands one bridge message to the app frame. */
export function nativeMcpAppPost(json: string): string {
  return `window.__solusMcpReceive && window.__solusMcpReceive(${JSON.stringify(json)}); true;`
}
