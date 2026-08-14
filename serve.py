#!/usr/bin/env python3
"""Development server with no-cache headers and correct WASM MIME type."""
import http.server
import functools
import sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm',
        '.mjs': 'application/javascript',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
handler = functools.partial(NoCacheHandler, directory='.')
print(f'Serving on http://localhost:{port} (no-cache)')
http.server.HTTPServer(('', port), handler).serve_forever()
