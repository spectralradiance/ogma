"""Run the sidecar: python -m oisin_ai --port 8765 [--watch-stdin]

The desktop app sets OISIN_SIDECAR_TOKEN and passes --watch-stdin. When run by hand
without a token, one is generated and printed so the API can still be exercised.
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import threading

import uvicorn

from .main import create_app

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _exit_when_stdin_closes() -> None:
    """The desktop app holds our stdin open. EOF means it is gone, even if it crashed."""
    try:
        while sys.stdin.buffer.read(4096):
            pass
    finally:
        os._exit(0)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="oisin_ai", description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--watch-stdin", action="store_true", help="exit when stdin reaches EOF")
    args = parser.parse_args(argv)

    if args.host not in LOOPBACK_HOSTS:
        parser.error("the sidecar only binds to loopback addresses")

    token = os.environ.get("OISIN_SIDECAR_TOKEN", "")
    if not token:
        token = secrets.token_hex(32)
        print(f"OISIN_SIDECAR_TOKEN not set; token for this session: {token}", flush=True)

    if args.watch_stdin:
        threading.Thread(target=_exit_when_stdin_closes, name="stdin-watch", daemon=True).start()

    uvicorn.run(create_app(token), host=args.host, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
