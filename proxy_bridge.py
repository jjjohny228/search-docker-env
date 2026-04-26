import json
import os
import select
import socket
import socketserver
import ssl
from pathlib import Path
from urllib.parse import urlsplit

import socks


PROXY_STATE_PATH = Path(os.environ.get("PROXY_STATE_PATH", "proxy_state.json"))
PROXY_BRIDGE_HOST = os.environ.get("PROXY_BRIDGE_HOST", "0.0.0.0")
PROXY_BRIDGE_PORT = int(os.environ.get("PROXY_BRIDGE_PORT", "3128"))
EXPECTED_SOCKET_ERRORS = (
    BrokenPipeError,
    ConnectionResetError,
    ConnectionAbortedError,
    TimeoutError,
    OSError,
    ssl.SSLEOFError,
)


def load_proxy_state() -> dict:
    if not PROXY_STATE_PATH.exists():
        return {"active_index": 0, "proxies": []}
    try:
        return json.loads(PROXY_STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"active_index": 0, "proxies": []}


def get_active_proxy() -> str | None:
    state = load_proxy_state()
    proxies = state.get("proxies") or []
    if not proxies:
        return None
    active_index = int(state.get("active_index", 0) or 0)
    if active_index >= len(proxies):
        active_index = 0
    return proxies[active_index]


def open_upstream_socket(host: str, port: int) -> socket.socket:
    proxy = get_active_proxy()
    if not proxy:
        return socket.create_connection((host, port), timeout=30)

    parsed = urlsplit(proxy)
    upstream = socks.socksocket()
    upstream.set_proxy(
        proxy_type=socks.SOCKS5,
        addr=parsed.hostname,
        port=parsed.port,
        username=parsed.username,
        password=parsed.password,
        rdns=True,
    )
    upstream.settimeout(30)
    upstream.connect((host, port))
    return upstream


def relay_bidirectional(client: socket.socket, upstream: socket.socket) -> None:
    sockets = [client, upstream]
    while True:
        try:
            readable, _, exceptional = select.select(sockets, [], sockets, 30)
        except EXPECTED_SOCKET_ERRORS:
            return
        if exceptional:
            return
        if not readable:
            continue

        for source in readable:
            try:
                data = source.recv(65536)
            except EXPECTED_SOCKET_ERRORS:
                return
            if not data:
                return
            target = upstream if source is client else client
            try:
                target.sendall(data)
            except EXPECTED_SOCKET_ERRORS:
                return


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        exc_type, _, _ = __import__("sys").exc_info()
        if exc_type and issubclass(exc_type, EXPECTED_SOCKET_ERRORS):
            return
        super().handle_error(request, client_address)


class ProxyHandler(socketserver.StreamRequestHandler):
    def safe_write_response(self, payload: bytes) -> None:
        try:
            self.wfile.write(payload)
            self.wfile.flush()
        except EXPECTED_SOCKET_ERRORS:
            return

    def handle(self) -> None:
        request_line = self.rfile.readline(65536)
        if not request_line:
            return

        try:
            method, target, version = request_line.decode("utf-8").strip().split(" ", 2)
        except ValueError:
            return

        headers = []
        content_length = 0
        while True:
            line = self.rfile.readline(65536)
            if line in {b"\r\n", b"\n", b""}:
                break
            decoded = line.decode("utf-8", errors="replace")
            headers.append(decoded)
            if decoded.lower().startswith("content-length:"):
                try:
                    content_length = int(decoded.split(":", 1)[1].strip())
                except ValueError:
                    content_length = 0

        if method.upper() == "CONNECT":
            self.handle_connect(target)
            return

        self.handle_forward(method, target, version, headers, content_length)

    def handle_connect(self, target: str) -> None:
        if ":" in target:
            host, port_text = target.rsplit(":", 1)
            port = int(port_text)
        else:
            host, port = target, 443

        upstream = None
        try:
            upstream = open_upstream_socket(host, port)
            self.safe_write_response(b"HTTP/1.1 200 Connection established\r\n\r\n")
            relay_bidirectional(self.connection, upstream)
        except EXPECTED_SOCKET_ERRORS:
            return
        except Exception:
            self.safe_write_response(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        finally:
            if upstream:
                upstream.close()

    def handle_forward(
        self,
        method: str,
        target: str,
        version: str,
        headers: list[str],
        content_length: int,
    ) -> None:
        parsed = urlsplit(target)
        host = parsed.hostname
        if not host:
            return

        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        body = self.rfile.read(content_length) if content_length else b""
        upstream = None
        try:
            upstream = open_upstream_socket(host, port)
            filtered_headers = []
            for header in headers:
                if header.lower().startswith("proxy-connection:"):
                    continue
                filtered_headers.append(header)

            request_bytes = [f"{method} {path} {version}\r\n".encode("utf-8")]
            request_bytes.extend(header.encode("utf-8") for header in filtered_headers)
            request_bytes.append(b"\r\n")
            request_bytes.append(body)
            upstream.sendall(b"".join(request_bytes))
            relay_bidirectional(self.connection, upstream)
        except EXPECTED_SOCKET_ERRORS:
            return
        except Exception:
            self.safe_write_response(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        finally:
            if upstream:
                upstream.close()


def main() -> None:
    with ThreadingTCPServer((PROXY_BRIDGE_HOST, PROXY_BRIDGE_PORT), ProxyHandler) as server:
        print(f"Proxy bridge listening on {PROXY_BRIDGE_HOST}:{PROXY_BRIDGE_PORT}")
        server.serve_forever()


if __name__ == "__main__":
    main()
