#!/usr/bin/env python3
"""Sprite Forge - local web server.

Serves the static UI in this folder and exposes a tiny JSON API around rembg
for background removal. Everything is bound to 127.0.0.1: nothing is exposed
to the network and nothing leaves the machine.

    py server.py                # http://127.0.0.1:8756
    py server.py --port 9000
    py server.py --no-browser

Only the background remover needs the optional `rembg` package. The Trimmer,
Resizer and Checker run entirely in the browser and work without it.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

VERSION = "1.0.0"
HOST = "127.0.0.1"
DEFAULT_PORT = int(os.environ.get("PORT", "8756"))
MAX_UPLOAD = 64 * 1024 * 1024

ROOT = Path(__file__).resolve().parent
MODELS_DIR = Path.home() / ".u2net"

MODEL_FILES = {
    "birefnet-general": "birefnet-general.onnx",
    "birefnet-general-lite": "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
    "birefnet-portrait": "BiRefNet-portrait-epoch_150.onnx",
    "u2net_human_seg": "u2net_human_seg.onnx",
    "isnet-general-use": "isnet-general-use.onnx",
    "isnet-anime": "isnet-anime.onnx",
    "u2net": "u2net.onnx",
    "silueta": "silueta.onnx",
    "u2net_cloth_seg": "u2net_cloth_seg.onnx",
    "u2netp": "u2netp.onnx",
}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

# --------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------

_engine_lock = threading.Lock()
_engine = {"loaded": False, "module": None, "error": None}

CURRENT_PORT = {"value": DEFAULT_PORT}

_sessions = {}
_session_locks = {}
_session_guard = threading.Lock()
_inference_lock = threading.Lock()


def load_engine():
    """Import rembg once. Returns the module, or None with the error cached."""
    with _engine_lock:
        if not _engine["loaded"]:
            try:
                import rembg  # noqa: F401  (heavy import, kept lazy)

                _engine["module"] = rembg
            except Exception as exc:  # noqa: BLE001 - any import failure is fatal here
                _engine["module"] = None
                _engine["error"] = f"{type(exc).__name__}: {exc}"
            _engine["loaded"] = True
        return _engine["module"]


def engine_state():
    """Cheap availability probe - never imports rembg unless it already loaded."""
    with _engine_lock:
        if _engine["loaded"]:
            return _engine["module"] is not None, _engine["error"]

    try:
        import importlib.util

        return importlib.util.find_spec("rembg") is not None, None
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def engine_version():
    try:
        from importlib.metadata import version

        return version("rembg")
    except Exception:  # noqa: BLE001
        return None


def model_file(model_id):
    return MODEL_FILES.get(model_id, f"{model_id}.onnx")


def model_path(model_id):
    return MODELS_DIR / model_file(model_id)


def model_status():
    entries = []
    for model_id in MODEL_FILES:
        path = model_path(model_id)
        exists = path.is_file()
        entries.append(
            {
                "id": model_id,
                "file": path.name,
                "installed": exists,
                "bytes": path.stat().st_size if exists else 0,
            }
        )
    return entries


def get_session(model_id):
    """Creates (and caches) a rembg session. Downloads weights on first use."""
    with _session_guard:
        lock = _session_locks.setdefault(model_id, threading.Lock())

    with lock:
        session = _sessions.get(model_id)
        if session is not None:
            return session

        rembg = load_engine()
        if rembg is None:
            raise RuntimeError(
                "rembg is not installed. Run: py -m pip install \"rembg[cpu,cli]\""
            )

        try:
            session = rembg.new_session(model_id)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Could not load '{model_id}': {exc}") from exc

        _sessions[model_id] = session
        return session


def remove_background(data, model_id, matting, erode):
    rembg = load_engine()
    if rembg is None:
        raise RuntimeError(
            "rembg is not installed. Run: py -m pip install \"rembg[cpu,cli]\""
        )

    session = get_session(model_id)

    options = {}
    if matting:
        options.update(
            alpha_matting=True,
            alpha_matting_foreground_threshold=240,
            alpha_matting_background_threshold=10,
            alpha_matting_erode_size=max(0, min(64, int(erode))),
        )

    # onnxruntime sessions are not safe to call from two threads at once.
    with _inference_lock:
        return rembg.remove(data, session=session, **options)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"SpriteForge/{VERSION}"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt, *args):  # noqa: A003
        """Quiet by default: only failures are printed (see route())."""
        return

    def local_request(self):
        host = (self.headers.get("Host") or "").strip().lower()
        name = host.split(":")[0]
        return name in ("127.0.0.1", "localhost", "[::1]", "::1")

    def send_payload(self, status, content_type, payload, extra=None):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_json(self, status, payload, extra=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_payload(status, "application/json; charset=utf-8", body, extra)

    def send_text(self, status, text):
        self.send_payload(status, "text/plain; charset=utf-8", text)

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0

        if length <= 0:
            raise ValueError("Empty request body.")
        if length > MAX_UPLOAD:
            raise ValueError("That file is larger than 64 MB.")

        return self.rfile.read(length)

    # -- routing ----------------------------------------------------------

    def do_GET(self):  # noqa: N802
        self.route("GET")

    def do_HEAD(self):  # noqa: N802
        self.route("HEAD")

    def do_POST(self):  # noqa: N802
        self.route("POST")

    def route(self, method):
        if not self.local_request():
            self.send_text(403, "Forbidden")
            return

        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        try:
            if path.startswith("/api/"):
                self.handle_api(method, path, query)
            elif method in ("GET", "HEAD"):
                self.serve_static(path)
            else:
                self.send_text(405, "Method not allowed")
        except BrokenPipeError:
            self.close_connection = True
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"  ! {method} {path} failed: {exc}\n")
            try:
                self.send_json(500, {"error": str(exc)})
            except Exception:  # noqa: BLE001
                self.close_connection = True

    # -- static -----------------------------------------------------------

    def serve_static(self, path):
        relative = path.lstrip("/") or "index.html"
        candidate = (ROOT / relative).resolve()

        try:
            candidate.relative_to(ROOT)
        except ValueError:
            self.send_text(403, "Forbidden")
            return

        if candidate.is_dir():
            candidate = candidate / "index.html"

        if not candidate.is_file():
            if "." not in candidate.name:
                candidate = ROOT / "index.html"
            if not candidate.is_file():
                self.send_text(404, "Not found")
                return

        try:
            data = candidate.read_bytes()
        except OSError:
            self.send_text(404, "Not found")
            return

        suffix = candidate.suffix.lower()
        content_type = CONTENT_TYPES.get(suffix) or mimetypes.guess_type(str(candidate))[0]
        self.send_payload(200, content_type or "application/octet-stream", data)

    # -- api --------------------------------------------------------------

    def handle_api(self, method, path, query):
        if path == "/api/status" and method in ("GET", "HEAD"):
            self.send_json(200, status_payload())
            return

        if path == "/api/remove" and method == "POST":
            self.handle_remove(query)
            return

        if path == "/api/warmup" and method == "POST":
            self.handle_warmup(query)
            return

        if path == "/api/reveal" and method == "POST":
            self.handle_reveal()
            return

        self.send_json(404, {"error": "Unknown endpoint."})

    def handle_remove(self, query):
        model_id = (query.get("model") or ["u2net"])[0]
        matting = (query.get("matting") or ["0"])[0] in ("1", "true", "yes")
        try:
            erode = int((query.get("erode") or ["10"])[0])
        except ValueError:
            erode = 10

        if model_id not in MODEL_FILES:
            self.send_json(400, {"error": f"Unknown model '{model_id}'."})
            return

        try:
            data = self.read_body()
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return

        started = time.perf_counter()

        try:
            result = remove_background(data, model_id, matting, erode)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"  ! removal failed ({model_id}): {exc}\n")
            self.send_json(500, {"error": f"{exc}"})
            return

        elapsed = int((time.perf_counter() - started) * 1000)

        if not isinstance(result, (bytes, bytearray)):
            self.send_json(500, {"error": "The engine returned an unexpected result."})
            return

        self.send_payload(200, "image/png", bytes(result), {"X-Asset-Ms": str(elapsed)})

    def handle_warmup(self, query):
        model_id = (query.get("model") or [""])[0]

        if model_id not in MODEL_FILES:
            self.send_json(400, {"error": f"Unknown model '{model_id}'."})
            return

        started = time.perf_counter()

        try:
            get_session(model_id)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"  ! warmup failed ({model_id}): {exc}\n")
            self.send_json(500, {"error": f"{exc}"})
            return

        self.send_json(
            200,
            {
                "ok": True,
                "model": model_id,
                "seconds": round(time.perf_counter() - started, 2),
            },
        )

    def handle_reveal(self):
        try:
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            if sys.platform == "win32":
                os.startfile(str(MODELS_DIR))  # noqa: S606 - local app
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(MODELS_DIR)])
            else:
                subprocess.Popen(["xdg-open", str(MODELS_DIR)])
        except Exception as exc:  # noqa: BLE001
            self.send_json(500, {"error": f"Could not open the folder: {exc}"})
            return

        self.send_json(200, {"ok": True})


def status_payload():
    installed, error = engine_state()

    return {
        "ok": True,
        "engine": {
            "rembg": installed,
            "version": engine_version() if installed else None,
            "python": sys.version.split()[0],
            "error": None if installed else (error or "rembg is not installed."),
        },
        "modelsDir": str(MODELS_DIR),
        "models": model_status(),
        "server": {
            "version": VERSION,
            "host": HOST,
            "port": CURRENT_PORT["value"],
        },
    }


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - not all streams support it
            pass

    parser = argparse.ArgumentParser(description="Sprite Forge local server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="port to listen on")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    args = parser.parse_args()

    CURRENT_PORT["value"] = args.port
    url = f"http://{HOST}:{args.port}/"

    try:
        server = ThreadingHTTPServer((HOST, args.port), Handler)
    except OSError as exc:
        print(f"Could not listen on {HOST}:{args.port} - {exc}")
        print("Try a different port:  py server.py --port 8800")
        return 1

    print("")
    print("  Sprite Forge - local server")
    print("  " + "-" * 46)
    print(f"  UI       {url}")
    print(f"  Root     {ROOT}")
    print(f"  Models   {MODELS_DIR}")
    print(f"  Python   {sys.version.split()[0]}")
    print("")
    print("  The rembg engine loads on first use. Start with the BG Remover tab.")
    print("  Press Ctrl+C to stop.")
    print("")

    if not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
