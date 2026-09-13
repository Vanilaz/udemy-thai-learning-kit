"""Serve synthetic UI fixtures and allowlisted extension assets on loopback only."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = {"workspace.js", "workspace.css", "content.js", "overlay.css", "sites.js", "popup.js"}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/popup.html":
            html = (ROOT / "extension" / "popup.html").read_text(encoding="utf-8")
            html = html.replace('<script src="popup.js"></script>', '<script src="popup-fixture.js"></script><script src="extension/popup.js"></script>')
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def translate_path(self, path):
        name = path.split("?", 1)[0].rsplit("/", 1)[-1]
        if path.startswith("/extension/") and name in ASSETS:
            return str(ROOT / "extension" / name)
        if name in ("workspace.html", "workspace-frame.html", "workspace-fixture.js", "controller-frame.html", "controller-fixture.js", "popup-fixture.js"):
            return str(ROOT / "tests" / "fixtures" / name)
        return str(ROOT / "tests" / "fixtures" / "not-found")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18765)
    args = parser.parse_args()
    print(f"Synthetic preview: http://127.0.0.1:{args.port}/workspace.html", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
