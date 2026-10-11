"""Run the sidecar: python -m ogma_ai --port 8765 [--parent-pid PID]

The desktop app sets OGMA_SIDECAR_TOKEN and passes its own process id as
--parent-pid. When run by hand without a token, one is generated and printed so
the API can still be exercised.
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import threading
import time
from collections.abc import Callable

import uvicorn

from .main import create_app

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def wait_for_exit(pid: int, poll_seconds: float = 1.0) -> None:
    """Blocks until process `pid` has exited (returns at once if it is not running).

    This replaces watching stdin for EOF: on Windows a thread blocked reading a
    pipe makes other threads hang while loading some native libraries (numpy's
    import, and so PyTorch's, never finishes).
    """
    if sys.platform == "win32":
        import ctypes

        synchronize, infinite = 0x00100000, 0xFFFFFFFF
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        handle = kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            return
        try:
            kernel32.WaitForSingleObject(ctypes.c_void_p(handle), infinite)
        finally:
            kernel32.CloseHandle(ctypes.c_void_p(handle))
        return
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            pass  # exists, owned by someone else
        time.sleep(poll_seconds)


def watch_parent(pid: int, on_exit: Callable[[], None]) -> threading.Thread:
    """Calls `on_exit` once the desktop app is gone, even if it crashed."""

    def run() -> None:
        wait_for_exit(pid)
        on_exit()

    thread = threading.Thread(target=run, name="parent-watch", daemon=True)
    thread.start()
    return thread


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="ogma_ai", description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--parent-pid", type=int, default=None, help="exit when this process exits")
    args = parser.parse_args(argv)

    if args.host not in LOOPBACK_HOSTS:
        parser.error("the sidecar only binds to loopback addresses")

    token = os.environ.get("OGMA_SIDECAR_TOKEN", "")
    if not token:
        token = secrets.token_hex(32)
        print(f"OGMA_SIDECAR_TOKEN not set; token for this session: {token}", flush=True)

    server: uvicorn.Server | None = None

    def shutdown() -> None:
        if server is not None:
            server.should_exit = True

    server = uvicorn.Server(uvicorn.Config(
        create_app(token, shutdown=shutdown), host=args.host, port=args.port, log_level="info", access_log=False,
    ))
    if args.parent_pid is not None:
        watch_parent(args.parent_pid, lambda: os._exit(0))
    server.run()


if __name__ == "__main__":
    main()
