#!/usr/bin/env python3
"""AI 1인 회사 — 로컬 서버.

하는 일은 두 가지뿐입니다.
  1) index.html 을 http://localhost:8787 로 보여 줍니다.
  2) POST /api/systemone 요청에 API 키를 붙여 TypeSafe Jev API 로 전달합니다.

API 키는 환경변수 TYPESAFE_API_KEY 또는 이 파일 옆의 .env 파일에서 읽습니다.
  실행:  TYPESAFE_API_KEY=발급받은키 python3 server.py
"""
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8787"))
API_URL = "https://api.typesafe.ai/v1/systemone"
MAX_BODY = 256 * 1024
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}


def load_key():
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    env_file = HERE / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("TYPESAFE_API_KEY="):
                return line.split("=", 1)[1].strip().strip("\"'")
    return ""


class Handler(BaseHTTPRequestHandler):
    server_version = "ai-company/1.0"

    def _send(self, status, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _local_only(self):
        # 다른 웹사이트가 이 서버를 통해 내 API 키를 쓰지 못하게 막습니다.
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{h}" for h in ALLOWED_HOSTS}

    def do_GET(self):
        if not self._local_only():
            return self._send(403, {"error": "forbidden"})
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            page = HERE / "index.html"
            if not page.exists():
                return self._send(404, {"error": "index.html not found"})
            return self._send(200, page.read_bytes(), "text/html; charset=utf-8")
        if path == "/api/status":
            return self._send(200, {"ok": True, "hasKey": bool(load_key())})
        return self._send(404, {"error": "not_found"})

    def do_POST(self):
        if not self._local_only():
            return self._send(403, {"error": "forbidden"})
        if self.path.split("?", 1)[0] != "/api/systemone":
            return self._send(404, {"error": "not_found"})
        key = load_key()
        if not key:
            return self._send(401, {"error": "no_key"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "body_too_large"})
        req = urllib.request.Request(
            API_URL,
            data=self.rfile.read(length),
            method="POST",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "ai-company-office/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return self._send(res.status, res.read())
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read() or b"{}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return self._send(502, {"error": "upstream_unreachable", "detail": str(e)})

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/systemone"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"AI 1인 회사  →  http://localhost:{PORT}")
    if load_key():
        print("TYPESAFE_API_KEY 확인됨. 실제 Jev 판단을 사용합니다.")
    else:
        print("TYPESAFE_API_KEY 가 없습니다. 키를 넣기 전에는 체험 모드만 쓸 수 있습니다.")
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
