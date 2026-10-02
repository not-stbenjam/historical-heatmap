"""One independent Jev judgment per date, with durable checkpoints."""
import argparse
import asyncio
import collections
from datetime import date, datetime, timedelta, timezone
import getpass
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sqlite3
import time

import aiohttp

QUESTION = "Did something historically significant happen on this date?"
MODEL = "typesafe/jev-1.13"
ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
DATABASE = Path("data/history.sqlite")


def request_body(day):
    return {
        "model": MODEL,
        "state": {"date": day},
        "questions": {"significant": {"type": "noul", "instructions": QUESTION}},
    }


def open_database(path=DATABASE):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute("""CREATE TABLE IF NOT EXISTS results (
        date TEXT PRIMARY KEY, probability REAL NOT NULL CHECK(probability BETWEEN 0 AND 1),
        cost REAL NOT NULL, input_tokens INTEGER NOT NULL, latency REAL NOT NULL,
        collected_at TEXT NOT NULL, raw_json TEXT NOT NULL)""")
    spec = {"request": request_body("<date>"), "calendar": "proleptic Gregorian"}
    encoded = json.dumps(spec, sort_keys=True)
    fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
    previous = db.execute("SELECT value FROM metadata WHERE key='fingerprint'").fetchone()
    if previous and previous[0] != fingerprint:
        raise ValueError("Database belongs to a different prompt/model. Use a new database.")
    db.execute("INSERT OR IGNORE INTO metadata VALUES ('fingerprint', ?)", (fingerprint,))
    db.execute("INSERT OR IGNORE INTO metadata VALUES ('experiment', ?)", (encoded,))
    db.commit()
    return db


def dates_between(start, end):
    if start > end:
        raise ValueError("Start date must be on or before end date")
    for offset in range((end - start).days + 1):
        yield (start + timedelta(days=offset)).isoformat()


def probability_from_response(result):
    answer = result["answers"]["significant"]
    value = answer["noul"]
    if answer["type"] != "noul" or isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError("Unexpected Noul response")
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("Probability must be finite and within [0, 1]")
    return float(value)


class Collector:
    def __init__(self, args, db, days, key):
        self.args, self.db, self.key = args, db, key
        self.total = len(days)
        self.existing = {row[0] for row in db.execute("SELECT date FROM results")}
        self.done = sum(day in self.existing for day in days)
        self.initial_done = self.done
        self.pending = collections.deque(day for day in days if day not in self.existing)
        self.started = time.monotonic()
        self.errors = collections.Counter()
        self.completed_times = collections.deque()
        self.cooldown_until = 0
        self.next_request = 0
        self.failure = None
        self.status_path = args.database.parent / "status.json"
        self.cost = db.execute("SELECT COALESCE(SUM(cost),0) FROM results").fetchone()[0]

    async def pace(self):
        now = time.monotonic()
        scheduled = max(now, self.next_request, self.cooldown_until)
        self.next_request = scheduled + 1 / self.args.rps
        await asyncio.sleep(max(0, scheduled - now))
        # A 429 may have arrived while this request was waiting.
        while time.monotonic() < self.cooldown_until:
            await asyncio.sleep(self.cooldown_until - time.monotonic())

    async def fetch(self, session, day):
        for attempt in range(self.args.retries + 1):
            if self.failure:
                return None
            await self.pace()
            before = time.monotonic()
            try:
                async with session.post(ENDPOINT, json=request_body(day), allow_redirects=False) as response:
                    status = response.status
                    if status == 200:
                        result = await response.json(content_type=None)
                        probability = probability_from_response(result)
                        return probability, result, time.monotonic() - before
                    # Don't log response bodies: provider errors may contain request details.
                    await response.read()
                    self.errors[str(status)] += 1
                    if status not in (408, 429, 500, 502, 503, 504, 524, 529):
                        raise RuntimeError(f"HTTP {status} on {day}; stopped rather than skipping dates")
                    if status == 429:
                        delay = min(60, 2 ** (attempt + 1))
                        try:
                            delay = max(delay, float(response.headers.get("Retry-After", "0")))
                        except ValueError:
                            pass
                        self.cooldown_until = max(self.cooldown_until, time.monotonic() + delay)
            except (aiohttp.ClientError, asyncio.TimeoutError):
                self.errors["network"] += 1
            except (KeyError, ValueError, TypeError):
                self.errors["invalid_response"] += 1
            if attempt < self.args.retries:
                await asyncio.sleep(min(30, 0.5 * 2 ** attempt) + random.random())
        raise RuntimeError(f"Retries exhausted on {day}; rerun to resume missing dates")

    async def worker(self, session):
        while self.pending and not self.failure:
            day = self.pending.popleft()
            try:
                fetched = await self.fetch(session, day)
                if fetched is None:
                    return
                probability, result, latency = fetched
                usage = result.get("usage", {})
                cost = float(usage.get("cost") or 0)
                self.db.execute("INSERT INTO results VALUES (?, ?, ?, ?, ?, ?, ?)", (
                    day, probability, cost, usage.get("input_tokens", 0), latency,
                    datetime.now(timezone.utc).isoformat(), json.dumps(result, separators=(",", ":")),
                ))
                self.done += 1
                self.cost += cost
                self.completed_times.append(time.monotonic())
                if self.args.dates:
                    print(f"{day}: P(yes)={probability:.8f}, {latency:.2f}s, ${cost:.8f}", flush=True)
                if self.done % 100 == 0:
                    self.db.commit()
            except Exception as exc:
                self.failure = str(exc).replace(self.key, "[redacted]")

    def report(self):
        now = time.monotonic()
        while self.completed_times and self.completed_times[0] < now - 15:
            self.completed_times.popleft()
        elapsed = now - self.started
        recent_rate = len(self.completed_times) / min(15, max(elapsed, 0.01))
        average_rate = (self.done - self.initial_done) / max(elapsed, 0.01)
        eta = (self.total - self.done) / average_rate if average_rate else None
        status = {
            "done": self.done, "total": self.total, "percent": 100 * self.done / self.total,
            "elapsed_seconds": round(elapsed, 1), "dates_per_second": round(recent_rate, 1),
            "eta_seconds": round(eta, 1) if eta is not None else None,
            "cost_usd": round(self.cost, 6), "errors": dict(self.errors),
            "concurrency": self.args.concurrency, "failure": self.failure,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        temp = self.status_path.with_suffix(".tmp")
        temp.write_text(json.dumps(status, indent=2))
        temp.replace(self.status_path)
        eta_text = f"{eta / 60:.1f}m" if eta is not None else "unknown"
        print(f"{self.done:,}/{self.total:,} ({status['percent']:.1f}%) | "
              f"{recent_rate:.0f}/s | ETA {eta_text} | ${self.cost:.4f} | errors {dict(self.errors)}", flush=True)

    async def run(self):
        print(f"Question: {QUESTION}\nModel: {MODEL}\n"
              f"{self.total:,} dates, {self.done:,} already saved; "
              f"{self.args.concurrency} workers, max {self.args.rps:g} requests/s", flush=True)
        connector = aiohttp.TCPConnector(limit=self.args.concurrency, ttl_dns_cache=300)
        timeout = aiohttp.ClientTimeout(total=45, connect=15)
        headers = {"Authorization": "Bearer " + self.key, "X-Title": "How Jev sees history"}
        try:
            async with aiohttp.ClientSession(connector=connector, timeout=timeout, headers=headers) as session:
                workers = [asyncio.create_task(self.worker(session)) for _ in range(self.args.concurrency)]
                try:
                    while any(not worker.done() for worker in workers):
                        await asyncio.sleep(5)
                        self.db.commit()
                        self.report()
                        if self.failure:
                            for worker in workers:
                                worker.cancel()
                            break
                    await asyncio.gather(*workers, return_exceptions=True)
                finally:
                    for worker in workers:
                        worker.cancel()
                    await asyncio.gather(*workers, return_exceptions=True)
        finally:
            self.db.commit()
            self.report()
        if self.failure:
            raise RuntimeError(self.failure)
        if self.done != self.total:
            raise RuntimeError(f"Incomplete: {self.done}/{self.total}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=date.fromisoformat, default=date(1492, 1, 1))
    parser.add_argument("--end", type=date.fromisoformat, default=date.today())
    parser.add_argument("--dates", nargs="+", help="Pilot: a few individual ISO dates")
    parser.add_argument("--concurrency", type=int, default=100)
    parser.add_argument("--rps", type=float, default=400)
    parser.add_argument("--retries", type=int, default=8)
    parser.add_argument("--database", type=Path, default=DATABASE)
    args = parser.parse_args()
    if args.concurrency < 1 or args.rps <= 0:
        parser.error("Concurrency and requests per second must be positive")
    days = sorted({date.fromisoformat(day).isoformat() for day in args.dates}) if args.dates else list(dates_between(args.start, args.end))
    if not days:
        parser.error("No dates requested")
    key = os.environ.get("OPENROUTER_API_KEY") or getpass.getpass("OpenRouter API key (hidden): ")
    if not key.strip():
        parser.error("An API key is required")
    db = open_database(args.database)
    try:
        asyncio.run(Collector(args, db, days, key.strip()).run())
    finally:
        db.close()


if __name__ == "__main__":
    main()
