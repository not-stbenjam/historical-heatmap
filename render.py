"""Export the actual API results as CSV, an interactive page, and a PNG."""
import argparse
import calendar
import csv
from datetime import date, timedelta
import json
import os
from pathlib import Path
import re
import sqlite3

os.environ.setdefault("MPLCONFIGDIR", str(Path(".cache/matplotlib").resolve()))
import matplotlib
matplotlib.use("Agg")
from matplotlib import pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import numpy as np

from collect import DATABASE, QUESTION, MODEL, dates_between

ROOT = Path(__file__).parent
COLORS = ["#f0ece3", "#edcba5", "#e9a06b", "#cf663d", "#a83224"]


def calendar_column(day):
    """Use a leap-year template so March 1 is the same column in every year."""
    return (date(2000, day.month, day.day) - date(2000, 1, 1)).days


def load_data(database, start, end):
    with sqlite3.connect(database) as db:
        rows = db.execute("SELECT date, probability, cost, input_tokens, latency, raw_json "
                          "FROM results WHERE date BETWEEN ? AND ? ORDER BY date",
                          (start.isoformat(), end.isoformat())).fetchall()
        experiment = json.loads(db.execute("SELECT value FROM metadata WHERE key='experiment'").fetchone()[0])
    values_by_date = {row[0]: row[1] for row in rows}
    all_days = list(dates_between(start, end))
    probabilities = [values_by_date.get(day) for day in all_days]
    events = json.loads((ROOT / "events.json").read_text())
    events = [dict(event, probability=values_by_date.get(event["date"])) for event in events if start.isoformat() <= event["date"] <= end.isoformat()]
    values = np.array([row[1] for row in rows])
    models = sorted({json.loads(row[5])["model"] for row in rows})
    stats = {
        "evaluated": len(rows), "total": len(all_days), "missing": len(all_days) - len(rows),
        "yes": int(np.sum(values >= 0.5)), "high": int(np.sum(values >= 0.9)),
        "mean": float(np.mean(values)) if len(rows) else None,
        "median": float(np.median(values)) if len(rows) else None,
        "cost": sum(row[2] for row in rows),
        "input_tokens": sum(row[3] for row in rows),
        "median_latency": float(np.median([row[4] for row in rows])) if rows else None,
        "models": models,
    }
    return rows, {
        "start": start.isoformat(), "end": end.isoformat(), "question": QUESTION,
        "model": MODEL, "experiment": experiment, "stats": stats,
        "probabilities": probabilities, "events": events,
    }


def draw_png(data, output):
    start, end = date.fromisoformat(data["start"]), date.fromisoformat(data["end"])
    years = end.year - start.year + 1
    grid = np.full((years, 366), np.nan)
    for offset, probability in enumerate(data["probabilities"]):
        if probability is not None:
            day = start + timedelta(days=offset)
            grid[day.year - start.year, calendar_column(day)] = probability
    cmap = LinearSegmentedColormap.from_list("history", COLORS)
    cmap.set_bad("#dedbd3")
    plt.rcParams.update({"font.family": "DejaVu Sans", "text.color": "#24251f", "axes.labelcolor": "#66685f", "xtick.color": "#66685f", "ytick.color": "#66685f"})
    fig = plt.figure(figsize=(16, 11.5), facecolor="#faf8f2")
    fig.text(0.06, 0.951, "How Jev sees history", fontsize=30, fontweight="bold")
    stats = data["stats"]
    fig.text(0.06, 0.913, f"{start.year}\u2013{end.year}  \u00b7  {stats['evaluated']:,} dates  \u00b7  Jev 1.13", fontsize=12, color="#64665c")
    ax = fig.add_axes([0.065, 0.16, 0.71, 0.67])
    image = ax.imshow(grid, aspect="auto", interpolation="nearest", cmap=cmap, vmin=0, vmax=1)
    month_starts = [calendar_column(date(2000, month, 1)) for month in range(1, 13)]
    ax.set_xticks([value + 13 for value in month_starts], [calendar.month_abbr[month] for month in range(1, 13)])
    ax.xaxis.tick_top()
    ax.tick_params(axis="both", length=0, pad=9)
    ticks = sorted({start.year, end.year, *range(((start.year + 49) // 50) * 50, end.year, 50)})
    ax.set_yticks([year - start.year for year in ticks], [str(year) for year in ticks])
    for value in month_starts[1:]:
        ax.axvline(value - 0.5, color="#fffdf7", alpha=0.5, linewidth=0.4)
    for spine in ax.spines.values():
        spine.set_visible(False)
    fig.text(0.81, 0.822, "Selected events", fontsize=12, fontweight="bold", color="#64665c")
    featured = ["1776-07-04", "1815-06-18", "1918-11-11", "1945-05-08", "1945-09-02", "1963-11-22", "1969-07-20"]
    y = 0.777
    for event in [item for item in data["events"] if item["date"] in featured]:
        p = event["probability"]
        short = {"US Declaration of Independence adopted": "US independence", "WWI armistice takes effect on the Western Front": "WWI armistice", "Japan signs the WWII surrender instrument": "WWII surrender", "Assassination of John F. Kennedy": "JFK assassination", "Apollo 11 lands on the Moon": "Moon landing"}.get(event["title"], event["title"])
        fig.text(0.81, y, event["date"], fontsize=10, color="#64665c")
        fig.text(0.81, y - 0.022, short, fontsize=11)
        fig.text(0.81, y - 0.047, f"{p:.0%} yes" if p is not None else "Pending", fontsize=15, color="#a83224", fontweight="bold")
        y -= 0.084
    cax = fig.add_axes([0.065, 0.094, 0.29, 0.015])
    colorbar = fig.colorbar(image, cax=cax, orientation="horizontal", ticks=[0, 0.5, 1])
    colorbar.ax.set_xticklabels(["0%", "50%", "100%"])
    colorbar.outline.set_visible(False)
    fig.text(0.38, 0.096, "Probability of \u201cyes\u201d \u00b7 one cell per date", fontsize=11, color="#64665c")
    if stats["missing"]:
        fig.text(0.81, 0.11, f"IN PROGRESS\n{stats['missing']:,} dates pending", fontsize=10, color="#a83224")
    fig.savefig(output, dpi=180, facecolor=fig.get_facecolor())
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DATABASE)
    parser.add_argument("--start", type=date.fromisoformat, default=date(1492, 1, 1))
    parser.add_argument("--end", type=date.fromisoformat, default=date(2026, 10, 2))
    args = parser.parse_args()
    rows, data = load_data(args.database, args.start, args.end)
    web = ROOT / "web"
    web.mkdir(exist_ok=True)
    (web / "data.json").write_text(json.dumps(data, separators=(",", ":")))
    (web / "summary.json").write_text(json.dumps({key: value for key, value in data.items() if key != "probabilities"}, indent=2))
    # A portable page also works from file:// with no server or network.
    template = (web / "index.html").read_text()
    style = (web / "style.css").read_text()
    portable = re.sub(r'<link rel="stylesheet" href="style\.css(?:\?[^\"]*)?">', lambda _: "<style>" + style + "</style>", template)
    for name in ["analytics.js", "app.js", "insights.js"]:
        inline = '<script defer>' + (web / name).read_text() + '</script>'
        if name == "app.js":
            inline = '<script>window.HISTORY_DATA=' + json.dumps(data, separators=(",", ":")) + ";</script>" + inline
        portable = re.sub(r'<script src="' + re.escape(name) + r'(?:\?[^\"]*)?" defer></script>', lambda _, value=inline: value, portable)
    (web / "history.html").write_text(portable)
    with (web / "results.csv").open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "probability_yes", "cost_usd", "input_tokens", "latency_seconds"])
        writer.writerows(row[:5] for row in rows)
    draw_png(data, web / "heatmap.png")
    print(json.dumps(data["stats"], indent=2))
    print("Exported web/history.html, web/heatmap.png, web/results.csv")


if __name__ == "__main__":
    main()
