"""ADMIN_EMAIL 계정을 관리자로 승격한다.

    python -m python.scripts.bootstrap_admin

Supabase Auth 에서 해당 이메일로 먼저 가입(매직링크)한 뒤 실행한다.
"""
from __future__ import annotations

from ..common.config import force_utf8_stdout, require
from ..common.db import get_client


def main() -> None:
    force_utf8_stdout()
    email = require("ADMIN_EMAIL")
    supabase = get_client()

    rows = supabase.table("profiles").select("id, email, role").eq("email", email).execute().data or []
    if not rows:
        raise SystemExit(
            f"{email} 계정을 찾지 못했습니다.\n"
            "먼저 /admin 에서 이 이메일로 로그인(매직링크)한 뒤 다시 실행하세요."
        )

    supabase.table("profiles").update({"role": "admin"}).eq("email", email).execute()
    print(f"{email} 을 관리자로 승격했습니다.")


if __name__ == "__main__":
    main()
