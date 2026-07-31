"""구조화 로그 (TS 쪽 lib/shared/logger.ts 와 같은 한 줄 JSON 형식)."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone


def _emit(level: str, job: str, message: str, **fields) -> None:
    line = json.dumps(
        {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "job": job,
            "message": message,
            **fields,
        },
        ensure_ascii=False,
    )
    stream = sys.stderr if level in ("warn", "error") else sys.stdout
    print(line, file=stream, flush=True)


class Logger:
    def __init__(self, job: str) -> None:
        self.job = job

    def info(self, message: str, **fields) -> None:
        _emit("info", self.job, message, **fields)

    def warn(self, message: str, **fields) -> None:
        _emit("warn", self.job, message, **fields)

    def error(self, message: str, **fields) -> None:
        _emit("error", self.job, message, **fields)

    def debug(self, message: str, **fields) -> None:
        _emit("debug", self.job, message, **fields)
