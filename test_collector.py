"""Exercise recovery/resume with a real local HTTP server, without paid requests."""
import argparse
from datetime import date
import json
from pathlib import Path
import tempfile
import unittest

from aiohttp import web

import collect
from render import calendar_column


class CalendarTests(unittest.TestCase):
    def test_complete_range_has_only_valid_unique_dates(self):
        days = list(collect.dates_between(date(1492, 1, 1), date(2026, 10, 2)))
        self.assertEqual(len(days), 195315)
        self.assertEqual(len(set(days)), len(days))
        self.assertIn("1600-02-29", days)
        self.assertNotIn("1700-02-29", days)
        self.assertIn("2000-02-29", days)
        self.assertNotIn("1900-02-29", days)
        self.assertEqual(days[-1], "2026-10-02")

    def test_months_align_across_leap_years(self):
        self.assertEqual(calendar_column(date(1968, 3, 1)), calendar_column(date(1969, 3, 1)))
        self.assertEqual(calendar_column(date(1968, 2, 29)), 59)
        self.assertEqual(calendar_column(date(1969, 12, 31)), 365)

    def test_invalid_probabilities_are_never_plotted_as_zero(self):
        for value in [None, "0.8", True, float("nan"), float("inf"), -0.1, 1.1]:
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                collect.probability_from_response({"answers": {"significant": {"type": "noul", "noul": value}}})


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(".cache"))
        self.database = Path(self.temp.name) / "test.sqlite"
        self.db = collect.open_database(self.database)
        self.original_endpoint = collect.ENDPOINT
        self.calls = []
        self.mode = "success"
        self.throttled = False
        app = web.Application()
        app.router.add_post("/decisions", self.handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        collect.ENDPOINT = f"http://127.0.0.1:{port}/decisions"

    async def asyncTearDown(self):
        collect.ENDPOINT = self.original_endpoint
        await self.runner.cleanup()
        self.db.close()
        self.temp.cleanup()

    async def handle(self, request):
        body = await request.json()
        self.calls.append(body)
        if self.mode == "fatal":
            return web.json_response({"error": "bad request"}, status=400)
        if self.mode == "throttle" and not self.throttled:
            self.throttled = True
            return web.json_response({"error": "slow down"}, status=429, headers={"Retry-After": "0"})
        return web.json_response({"model": collect.MODEL, "answers": {"significant": {"type": "noul", "noul": 0.83}}, "usage": {"cost": 0.01, "input_tokens": 100}})

    def collector(self, days):
        args = argparse.Namespace(database=self.database, concurrency=2, retries=1, rps=100, dates=days)
        return collect.Collector(args, self.db, days, "fake-test-key")

    async def test_resume_does_not_repeat_paid_requests_or_leak_event_context(self):
        days = ["1963-11-22", "1969-07-20"]
        await self.collector(days).run()
        self.db.close()
        self.db = collect.open_database(self.database)
        await self.collector(days).run()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM results").fetchone()[0], 2)
        for body in self.calls:
            self.assertEqual(set(body["state"]), {"date"})
            self.assertEqual(body["questions"]["significant"], {"type": "noul", "instructions": collect.QUESTION})

    async def test_rate_limit_is_retried_and_result_is_saved(self):
        self.mode = "throttle"
        collector = self.collector(["1945-09-02"])
        await collector.run()
        self.assertEqual(collector.errors["429"], 1)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.db.execute("SELECT probability FROM results").fetchone()[0], 0.83)

    async def test_fatal_request_error_stops_without_fabricating_a_result(self):
        self.mode = "fatal"
        with self.assertRaisesRegex(RuntimeError, "HTTP 400"):
            await self.collector(["1945-09-02"]).run()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM results").fetchone()[0], 0)
        status = json.loads((self.database.parent / "status.json").read_text())
        self.assertEqual(status["done"], 0)
        self.assertIn("HTTP 400", status["failure"])


if __name__ == "__main__":
    Path(".cache").mkdir(exist_ok=True)
    unittest.main()
