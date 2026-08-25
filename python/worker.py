"""Resident SynOmega worker: newline-delimited JSON over stdin/stdout.

One JSON object per line in, one per line out. stdout carries the protocol and
nothing else — every diagnostic goes to stderr, because a stray print would
corrupt the frame stream.

    -> {"id": "7", "op": "plan", "params": {"target": "CC(=O)O", "max_depth": 5}}
    <- {"id": "7", "ok": true,  "data": {...}}
    <- {"id": "7", "ok": false, "error": {"kind": "invalid_smiles", "message": "..."}}

Requests are handled strictly in arrival order on the main thread: SynOmega's
model inference is not guaranteed thread-safe, and concurrency here would only
make each caller slower. The host serializes too, so this is belt and braces.
"""

from __future__ import annotations

import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ops import OpError, Session, dispatch  # noqa: E402


def _write(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    sys.stderr.write("[synomega-worker] %s\n" % message)
    sys.stderr.flush()


def handle(session: Session, request: dict) -> dict:
    request_id = request.get("id")
    op = request.get("op")
    try:
        data = dispatch(session, op, request.get("params") or {})
        return {"id": request_id, "ok": True, "data": data}
    except OpError as exc:
        return {"id": request_id, "ok": False,
                "error": {"kind": exc.kind, "message": exc.message}}
    except Exception as exc:  # noqa: BLE001 - the boundary: nothing may escape
        _log("op %r failed: %s" % (op, traceback.format_exc()))
        return {"id": request_id, "ok": False,
                "error": {"kind": "internal",
                          "message": "%s: %s" % (type(exc).__name__, exc)}}


def main() -> int:
    session = Session()
    _write({"event": "ready", "pid": os.getpid(), "python": sys.version.split()[0]})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as exc:
            _write({"id": None, "ok": False,
                    "error": {"kind": "bad_frame", "message": "unparsable JSON line: %s" % exc}})
            continue
        if not isinstance(request, dict):
            _write({"id": None, "ok": False,
                    "error": {"kind": "bad_frame", "message": "frame must be a JSON object"}})
            continue
        if request.get("op") == "shutdown":
            _write({"id": request.get("id"), "ok": True, "data": {"bye": True}})
            return 0
        _write(handle(session, request))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
