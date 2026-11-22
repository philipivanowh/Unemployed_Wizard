"""One shared speed limit for every Graph API call, across all scripts and restarts.

Meta flags tokens for "suspicious activity" when calls come in bursts, when many different
accounts are looked up quickly, and when a client keeps calling after being told to stop. So:

  - calls are spaced at least config.GRAPH_MIN_SECONDS_BETWEEN_CALLS apart, plus random jitter
  - at most config.GRAPH_MAX_CALLS_PER_HOUR per hour and GRAPH_MAX_CALLS_PER_DAY per day
  - when Meta's usage headers pass config.GRAPH_USAGE_COOLDOWN_PERCENT, or it answers with a
    rate-limit or blocked-token error, ALL calls stop for a cooldown (config.GRAPH_COOLDOWN_HOURS)

The discovery loop, build_watchlist.py and testing.py share these limits through a small file
(config.GRAPH_LEDGER_FILE), so running them together can't add up to a burst.

    python -m instagram_scrapper.throttle            # show calls made and any cooldown (run from src/)
    python -m instagram_scrapper.throttle --clear    # lift a cooldown, e.g. after getting a new token
"""
import hashlib
import json
import os
import random
import sys
import time
from contextlib import contextmanager

import config

HOUR, DAY = 3600, 86400
RATE_LIMIT_CODES = {4, 17, 32, 613, 80002}
BLOCKED_CODES = {190, 200}  # token invalid, expired or blocked
_LOCK = config.GRAPH_LEDGER_FILE.with_suffix(".lock")


class Refused(Exception):
    """Calling now would break our limits. `wait` is how many seconds until it's allowed."""

    def __init__(self, message, wait):
        super().__init__(message)
        self.wait = wait


def token_id(token):
    """A short fingerprint, so a cooldown for a blocked token doesn't outlive the token."""
    return hashlib.sha256((token or "").encode()).hexdigest()[:12]


@contextmanager
def _locked():
    """A lock file shared by every process. A lock older than 30s is left over from a crash."""
    _LOCK.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            fd = os.open(_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - _LOCK.stat().st_mtime > 30:
                    _LOCK.unlink()
                    continue
            except FileNotFoundError:
                continue
            time.sleep(0.1)
    try:
        yield
    finally:
        os.close(fd)
        try:
            _LOCK.unlink()
        except FileNotFoundError:
            pass


def _load():
    try:
        ledger = json.loads(config.GRAPH_LEDGER_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        ledger = {}
    ledger.setdefault("calls", [])
    ledger["calls"] = [t for t in ledger["calls"] if t > time.time() - DAY]
    return ledger


def _save(ledger):
    tmp = config.GRAPH_LEDGER_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(ledger, indent=1), encoding="utf-8")
    os.replace(tmp, config.GRAPH_LEDGER_FILE)


def _cooldown_left(ledger, token):
    until = ledger.get("cooldown_until", 0)
    if until <= time.time():
        return 0
    # A cooldown because the token was blocked ends when the token is replaced.
    if ledger.get("cooldown_kind") == "blocked" and ledger.get("cooldown_token") != token_id(token):
        return 0
    return until - time.time()


def _wait_needed(ledger, token):
    """(seconds to wait, why) before the next call may be made."""
    now = time.time()
    left = _cooldown_left(ledger, token)
    if left:
        return left, f"cooling down: {ledger.get('cooldown_reason')}"
    calls = ledger["calls"]
    if len(calls) >= config.GRAPH_MAX_CALLS_PER_DAY:
        return calls[-config.GRAPH_MAX_CALLS_PER_DAY] + DAY - now, f"{config.GRAPH_MAX_CALLS_PER_DAY} calls in the last day"
    last_hour = [t for t in calls if t > now - HOUR]
    if len(last_hour) >= config.GRAPH_MAX_CALLS_PER_HOUR:
        return last_hour[-config.GRAPH_MAX_CALLS_PER_HOUR] + HOUR - now, f"{config.GRAPH_MAX_CALLS_PER_HOUR} calls in the last hour"
    return max(0.0, ledger.get("next_allowed_at", 0) - now), "spacing between calls"


def before_call(token, max_wait=None):
    """Block until a call is allowed, then record it. Raises Refused if that's more than
    max_wait seconds away (default config.GRAPH_MAX_WAIT_SECONDS)."""
    max_wait = config.GRAPH_MAX_WAIT_SECONDS if max_wait is None else max_wait
    while True:
        with _locked():
            ledger = _load()
            wait, why = _wait_needed(ledger, token)
            if wait <= 0:
                now = time.time()
                ledger["calls"].append(now)
                gap = config.GRAPH_MIN_SECONDS_BETWEEN_CALLS
                ledger["next_allowed_at"] = now + random.uniform(gap, gap * 1.5)
                _save(ledger)
                return
        # The normal gap between calls is always waited out; only caps and cooldowns make us give up.
        if wait > max_wait and why != "spacing between calls":
            raise Refused(f"Graph API paused for {wait / 60:.0f} more min ({why})", wait)
        time.sleep(wait + 0.05)


def wait_needed(token):
    """(seconds until the next call is allowed, why). Read-only: records nothing."""
    return _wait_needed(_load(), token)


def usage_percent(headers):
    """The highest percentage in Meta's usage headers (app, business-use-case, ad-account)."""
    best = 0.0
    for name in ("X-App-Usage", "X-Business-Use-Case-Usage", "X-Ad-Account-Usage"):
        raw = headers.get(name)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        stack = [data]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                for key, value in item.items():
                    if isinstance(value, (int, float)) and key != "estimated_time_to_regain_access":
                        best = max(best, float(value))
                    elif isinstance(value, (dict, list)):
                        stack.append(value)
            elif isinstance(item, list):
                stack.extend(item)
    return best


def after_call(token, headers, error_code=None):
    """Look at the answer: start a cooldown if Meta says we're close to, or over, a limit."""
    kind = reason = None
    if error_code in BLOCKED_CODES:
        kind, reason = "blocked", f"token refused (code {error_code}); replace IG_ACCESS_TOKEN"
    elif error_code in RATE_LIMIT_CODES:
        kind, reason = "rate_limit", f"Meta rate limit (code {error_code})"
    else:
        used = usage_percent(headers or {})
        if used >= config.GRAPH_USAGE_COOLDOWN_PERCENT:
            kind, reason = "usage", f"Meta reports {used:.0f}% of a usage limit used"
    if kind is None:
        return
    with _locked():
        ledger = _load()
        ledger.update(cooldown_until=time.time() + config.GRAPH_COOLDOWN_HOURS[kind] * HOUR,
                      cooldown_kind=kind, cooldown_reason=reason, cooldown_token=token_id(token))
        _save(ledger)


def status(token):
    ledger = _load()
    now = time.time()
    hour = sum(t > now - HOUR for t in ledger["calls"])
    lines = [f"calls in the last hour: {hour}/{config.GRAPH_MAX_CALLS_PER_HOUR}",
             f"calls in the last day:  {len(ledger['calls'])}/{config.GRAPH_MAX_CALLS_PER_DAY}"]
    left = _cooldown_left(ledger, token)
    lines.append(f"cooling down for {left / 3600:.1f} h: {ledger.get('cooldown_reason')}" if left else "no cooldown")
    return "\n".join(lines)


def clear_cooldown():
    with _locked():
        ledger = _load()
        for key in ("cooldown_until", "cooldown_kind", "cooldown_reason", "cooldown_token"):
            ledger.pop(key, None)
        _save(ledger)


if __name__ == "__main__":
    token = os.getenv("IG_ACCESS_TOKEN", "")
    if "--clear" in sys.argv[1:]:
        clear_cooldown()
        print("cooldown cleared")
    print(status(token))
