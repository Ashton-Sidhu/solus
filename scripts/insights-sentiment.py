#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["vaderSentiment>=3.3.2", "anthropic>=1.0", "pydantic>=2"]
# ///
"""Score Solus Insights turn prompts and aggregate sentiment per day.

Two scorers:

  VADER  - a lexicon. Free, instant, reproducible. It reads tone words but cannot
           tell a calm bug report from an angry one, and it reads the polite,
           aspirational vocabulary of a feature request ("premium", "great",
           "please") as the writer's mood.
  Claude - an LLM classifier over the same prompts, told explicitly to label the
           person's affect and not the topic. Costs money; results are cached on
           disk so a re-run is free.

The Insights database is live user data. This script opens it read-only and never
writes to it.

Usage:
    uv run scripts/insights-sentiment.py
    uv run scripts/insights-sentiment.py --samples 5
    uv run scripts/insights-sentiment.py --llm --llm-dry-run
    uv run scripts/insights-sentiment.py --llm --json out.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import statistics
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal

from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

DEFAULT_DB = os.path.join(os.path.expanduser("~"), ".solus", "metrics.db")
DEFAULT_LLM_CACHE = os.path.join(
    os.path.expanduser("~"), ".cache", "solus-insights-sentiment", "llm-labels.json"
)

# Prompts a harness replays verbatim hundreds of times. They are recorded with
# prompt_source='typed' but no human typed them, so they would flatten every average.
HARNESS_PROMPTS = ("Start peer", "Start caller", "Start ordered", "Start background")

# VADER is trained on social media. These words carry its social valence but are
# neutral vocabulary in a coding prompt, so the domain profile zeroes them out.
DOMAIN_NEUTRAL = (
    "kill", "killed", "kills", "abort", "aborted", "dead", "die", "dies", "block",
    "blocked", "blocking", "critical", "attack", "attacks", "hook", "hooks", "trap",
    "dirty", "stub", "dummy", "hack", "reject", "rejected", "strict", "force",
    "forced", "cheap", "expensive", "lost", "master", "slave", "orphan", "orphaned",
    "stress", "panic", "fatal", "warning", "warn", "danger", "dangerous", "risk",
    "risky", "poor", "weak", "hard", "escape", "escaped", "restrict", "restricted",
    "abandon", "abandoned", "destroy", "destroyed", "burn", "cut", "drop", "dropped",
    "flag", "flags", "flagged", "steal", "victim", "suspect", "conflict", "conflicts",
)

# Frustration and approval vocabulary VADER under-weights or does not know in a
# software context. Values are on VADER's own -4..+4 lexicon scale.
DOMAIN_LEXICON = {
    "regression": -2.2, "regressed": -2.2, "flaky": -1.8, "janky": -2.0,
    "borked": -2.5, "busted": -2.0, "stale": -1.2, "laggy": -1.8, "jank": -2.0,
    "unusable": -3.0, "nonsense": -2.2, "gross": -2.0, "yuck": -2.2,
    "clunky": -1.8, "brittle": -1.6, "bloated": -1.6, "convoluted": -1.6,
    "overengineered": -1.8, "slop": -2.0, "sloppy": -2.0, "hallucinated": -2.0,
    "misread": -1.4, "ignored": -1.6, "reverted": -1.2, "typo": -1.0,
    "snappy": 1.8, "polished": 2.0, "elegant": 2.2, "seamless": 2.0,
    "tidy": 1.5, "readable": 1.2, "idiomatic": 1.2, "ship": 1.0, "shipped": 1.4,
    "lgtm": 2.0, "nailed": 2.5, "spotless": 2.2,
}

CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`]*`")
URL = re.compile(r"https?://\S+")
PATHISH = re.compile(r"(?:[\w.\-]+/)+[\w.\-]+")
DIFF_LINE = re.compile(r"^[+\-@].*$", re.MULTILINE)
WHITESPACE = re.compile(r"\s+")
SENTENCE = re.compile(r"[.!?\n]+|(?<=\S) - (?=\S)")


def clean(prompt: str) -> str:
    """Strip the parts of a prompt no sentiment scorer should read.

    Fenced code, inline code, URLs, paths, and pasted diff hunks are noise: they
    contribute stray lexicon hits ("error", "kill", "fatal") that say nothing about
    how the person felt when they typed the prompt.
    """
    text = CODE_FENCE.sub(" ", prompt)
    text = INLINE_CODE.sub(" ", text)
    text = URL.sub(" ", text)
    text = DIFF_LINE.sub(" ", text)
    text = PATHISH.sub(" ", text)
    return WHITESPACE.sub(" ", text).strip()


def build_analyzers() -> tuple[SentimentIntensityAnalyzer, SentimentIntensityAnalyzer]:
    """Return the stock VADER analyzer and a domain-adjusted copy.

    Both are reported. Stock VADER is the reproducible baseline; the domain profile
    is the one to trust for coding prompts, where "kill the process" is not anger.
    """
    stock = SentimentIntensityAnalyzer()
    domain = SentimentIntensityAnalyzer()
    for word in DOMAIN_NEUTRAL:
        domain.lexicon.pop(word, None)
    domain.lexicon.update(DOMAIN_LEXICON)
    return stock, domain


def score_prompt(analyzer: SentimentIntensityAnalyzer, text: str) -> float:
    """Length-neutral VADER score for one prompt.

    VADER's compound score saturates toward +/-1 as a text gets longer, because every
    extra lexicon hit pushes the normalized sum further out. A three-paragraph feature
    request therefore outranks a one-line "this is broken" on tone it does not have.
    Averaging the per-sentence compounds removes that bias, so a long calm prompt and
    a short calm prompt land in the same place.
    """
    sentences = [part.strip() for part in SENTENCE.split(text) if part and part.strip()]
    if not sentences:
        return analyzer.polarity_scores(text)["compound"]
    return statistics.fmean(analyzer.polarity_scores(part)["compound"] for part in sentences)


def classify(compound: float) -> str:
    """VADER's documented thresholds for a single text."""
    if compound >= 0.05:
        return "positive"
    if compound <= -0.05:
        return "negative"
    return "neutral"


# --------------------------------------------------------------------------------
# LLM classifier
# --------------------------------------------------------------------------------

LLM_LABELS = ("frustrated", "mildly_negative", "neutral", "mildly_positive", "pleased")
LLM_SCORES = {
    "frustrated": -1.0,
    "mildly_negative": -0.5,
    "neutral": 0.0,
    "mildly_positive": 0.5,
    "pleased": 1.0,
}

# Bumping this invalidates the on-disk label cache, because a cached label is only
# meaningful under the instructions that produced it.
LLM_PROMPT_VERSION = "2026-08-26.1"

LLM_SYSTEM = """\
You label the emotional affect a developer expressed in a prompt they typed to a \
coding agent.

Label the person's feeling, not the topic. That distinction is the entire task, and \
it is the one a sentiment lexicon gets wrong:

- A calm, factual defect report is `neutral`. Saying something is broken, wrong, or \
failing is describing software, not expressing an emotion.
- A feature request is `neutral` however appealing its vocabulary. Words like \
"premium", "beautiful", "clean", "great UX" describe a desired outcome, not the \
writer's mood.
- "please", "thanks", "can you", "I'd like" are ordinary politeness. On their own \
they are `neutral`.
- `mildly_positive` and `pleased` require the person to express satisfaction with \
work already done: "that's perfect", "nice, that worked", "much better now".
- `mildly_negative` and `frustrated` require expressed annoyance, impatience, or \
dissatisfaction: "still broken", "you keep ignoring the instruction", "that's the \
third time", "wtf", swearing directed at the work.
- Read negation and sarcasm carefully. "that didn't work so great" is negative. \
"cool, another crash" is negative.
- Self-directed annoyance ("oh shit my bad") is `mildly_negative`, not `frustrated`.

Also record what drove the prompt:
- `defect_report` - reporting broken or wrong behaviour
- `agent_correction` - telling the agent it did the wrong thing
- `feature_request` - asking for something new
- `question` - asking for information or explanation
- `approval` - confirming, accepting, or praising work
- `instruction` - a plain directive with no defect and no new feature
- `other`

Return one object per prompt, echoing the index you were given."""

try:  # Optional: the script runs fine without the API surface unless --llm is used.
    from pydantic import BaseModel

    class PromptLabel(BaseModel):
        index: int
        label: Literal["frustrated", "mildly_negative", "neutral", "mildly_positive", "pleased"]
        driver: Literal[
            "defect_report", "agent_correction", "feature_request",
            "question", "approval", "instruction", "other",
        ]

    class BatchLabels(BaseModel):
        labels: list[PromptLabel]

except ImportError:  # pragma: no cover - only when deps are stripped
    PromptLabel = BatchLabels = None


# Anthropic list prices, USD per million tokens, as of 2026-06.
PRICING = {
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}


def require_credentials() -> None:
    """Fail early and legibly instead of at the first request.

    The SDK resolves credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
    `ant auth login` profile on disk. With none of them set it raises a bare TypeError
    from deep inside the request builder, which reads like a bug in this script.
    """
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return
    profiles = os.path.join(os.path.expanduser("~"), ".config", "anthropic")
    if os.path.isdir(profiles) and os.listdir(profiles):
        return
    sys.exit(
        "No Anthropic credentials found.\n"
        "  export ANTHROPIC_API_KEY=sk-ant-...   (or run `ant auth login`)\n"
        "Then re-run with --llm. Everything except --llm works without credentials."
    )


def label_key(text: str, model: str) -> str:
    digest = hashlib.sha256(f"{LLM_PROMPT_VERSION}\0{model}\0{text}".encode()).hexdigest()
    return digest[:32]


def load_label_cache(path: str) -> dict[str, dict[str, str]]:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}


def save_label_cache(path: str, cache: dict[str, dict[str, str]]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(cache, handle)


def render_batch(texts: list[str]) -> str:
    """One user message holding a whole batch, index-tagged so replies can be aligned."""
    blocks = [f"<prompt index=\"{i}\">\n{text}\n</prompt>" for i, text in enumerate(texts)]
    return "Label each of the following prompts.\n\n" + "\n\n".join(blocks)


def classify_batch(client, model: str, effort: str, texts: list[str]):
    """Label one batch. Returns the labels that came back, keyed by batch index.

    A batch that errors or returns a short list is not fatal: the caller retries the
    missing indices one at a time, and anything still missing is reported as a failure
    rather than silently scored as neutral.
    """
    response = client.messages.parse(
        model=model,
        max_tokens=8000,
        output_config={"effort": effort},
        system=[{"type": "text", "text": LLM_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": render_batch(texts)}],
        output_format=BatchLabels,
    )
    usage = response.usage
    parsed = response.parsed_output
    labels = {}
    if parsed:
        for item in parsed.labels:
            if 0 <= item.index < len(texts):
                labels[item.index] = item
    return labels, usage


def run_llm(
    client,
    model: str,
    effort: str,
    texts: list[str],
    batch_size: int,
    concurrency: int,
    cache: dict[str, dict[str, str]],
) -> tuple[dict[str, dict[str, str]], dict[str, int], int]:
    """Label every text not already in the cache. Mutates and returns the cache."""
    outstanding = [text for text in dict.fromkeys(texts) if label_key(text, model) not in cache]
    if not outstanding:
        return cache, Counter(), 0

    totals: Counter = Counter()
    remaining = len(outstanding)

    def work(batch: list[str]):
        try:
            return classify_batch(client, model, effort, batch), batch
        except Exception as error:  # noqa: BLE001 - one bad batch must not kill the run
            print(f"  batch failed: {type(error).__name__}: {error}", file=sys.stderr)
            return ({}, None), batch

    # Second pass sends the stragglers one at a time. A batch loses items for two
    # reasons - the whole request errored, or the model returned a short list - and a
    # singleton request removes both without re-labelling the ones that succeeded.
    for size in (batch_size, 1):
        if not outstanding:
            break
        batches = [outstanding[i : i + size] for i in range(0, len(outstanding), size)]
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            for (labels, usage), batch in pool.map(work, batches):
                if usage is not None:
                    totals["input"] += usage.input_tokens
                    totals["output"] += usage.output_tokens
                    totals["cache_read"] += getattr(usage, "cache_read_input_tokens", 0) or 0
                    totals["cache_write"] += getattr(usage, "cache_creation_input_tokens", 0) or 0
                for index, text in enumerate(batch):
                    item = labels.get(index)
                    if item is not None:
                        cache[label_key(text, model)] = {"label": item.label, "driver": item.driver}
        outstanding = [text for text in outstanding if label_key(text, model) not in cache]
        print(f"  labelled {remaining - len(outstanding)}/{remaining}", file=sys.stderr)

    return cache, totals, len(outstanding)


def estimate_cost(model: str, totals: Counter) -> float:
    input_price, output_price = PRICING.get(model, (0.0, 0.0))
    return (
        totals["input"] * input_price
        + totals["cache_write"] * input_price * 1.25
        + totals["cache_read"] * input_price * 0.1
        + totals["output"] * output_price
    ) / 1_000_000


# --------------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------------


# Insights records the context-window variant and the dated snapshot in the model
# string. Both are the same model for the purpose of "how did I talk to it".
MODEL_SUFFIX = re.compile(r"\[\dm\]$|-\d{8}$")


def normalize_model(model: str | None) -> str:
    if not model:
        return "unknown"
    return MODEL_SUFFIX.sub("", MODEL_SUFFIX.sub("", model))


@dataclass
class Record:
    day: str
    model: str
    provider: str
    text: str
    compound: float
    whole_compound: float
    stock_compound: float
    llm_label: str | None = None
    llm_driver: str | None = None


@dataclass
class Bucket:
    key: str
    compounds: list[float] = field(default_factory=list)
    whole_compounds: list[float] = field(default_factory=list)
    stock_compounds: list[float] = field(default_factory=list)
    llm_scores: list[float] = field(default_factory=list)
    positive: int = 0
    neutral: int = 0
    negative: int = 0
    llm_positive: int = 0
    llm_neutral: int = 0
    llm_negative: int = 0


def load_turns(db_path: str, days: int, keep_harness: bool, today_only: bool) -> list[tuple]:
    if not os.path.exists(db_path):
        sys.exit(f"No Insights database at {db_path}")

    if today_only:
        # Local midnight, because a "day" here is the user's day, not UTC's.
        midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        since = int(midnight.timestamp() * 1000)
    else:
        since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp() * 1000)
    placeholders = ",".join("?" * len(HARNESS_PROMPTS))
    harness_clause = "" if keep_harness else f" AND prompt NOT IN ({placeholders})"
    params: list[object] = [since]
    if not keep_harness:
        params.extend(HARNESS_PROMPTS)

    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return connection.execute(
            "SELECT started_at, model, provider, prompt FROM turns"
            " WHERE prompt_source = 'typed'"
            "   AND started_at >= ?"
            "   AND prompt IS NOT NULL"
            "   AND length(trim(prompt)) > 0"
            f"{harness_clause}"
            " ORDER BY started_at",
            params,
        ).fetchall()
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=DEFAULT_DB, help=f"Insights database (default: {DEFAULT_DB})")
    parser.add_argument("--days", type=int, default=30, help="Look-back window in days")
    parser.add_argument("--today", action="store_true", help="Only the current local calendar day")
    parser.add_argument("--by", default="day", choices=["day", "model"], help="Grouping dimension")
    parser.add_argument("--min-group", type=int, default=1,
                        help="Collapse groups with fewer prompts than this into 'other'")
    parser.add_argument("--json", dest="json_path", help="Write the per-day series to this JSON file")
    parser.add_argument("--samples", type=int, default=0, help="Print N most negative and N most positive prompts")
    parser.add_argument("--keep-harness", action="store_true", help="Do not drop replayed harness prompts")
    parser.add_argument("--llm", action="store_true", help="Also classify prompts with Claude")
    parser.add_argument("--llm-model", default="claude-opus-5", help="Model for the classifier")
    parser.add_argument("--llm-effort", default="low", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--llm-scope", default="all", choices=["all", "nonneutral"],
                        help="'nonneutral' only labels prompts VADER did not call neutral (cheaper, but the daily mean is then partial)")
    parser.add_argument("--llm-batch", type=int, default=25, help="Prompts per request")
    parser.add_argument("--llm-concurrency", type=int, default=6, help="Concurrent requests")
    parser.add_argument("--llm-cache", default=DEFAULT_LLM_CACHE, help="On-disk label cache")
    parser.add_argument("--llm-dry-run", action="store_true", help="Estimate tokens and cost, then stop")
    parser.add_argument("--disagreements", type=int, default=0, help="Print N prompts where VADER and Claude disagree most")
    args = parser.parse_args()

    rows = load_turns(args.db, args.days, args.keep_harness, args.today)
    if not rows:
        sys.exit("No typed prompts in the window.")

    stock, domain = build_analyzers()
    records: list[Record] = []
    empty_after_clean = 0

    for started_at, model, provider, prompt in rows:
        text = clean(prompt)
        if not text:
            # A prompt that was only code or a path has no language to score.
            empty_after_clean += 1
            continue
        records.append(
            Record(
                day=datetime.fromtimestamp(started_at / 1000).strftime("%Y-%m-%d"),
                model=normalize_model(model),
                provider=provider or "unknown",
                text=text,
                compound=score_prompt(domain, text),
                whole_compound=domain.polarity_scores(text)["compound"],
                stock_compound=score_prompt(stock, text),
            )
        )

    llm_totals: Counter = Counter()
    llm_failures = 0
    if args.llm:
        if BatchLabels is None:
            sys.exit("pydantic is required for --llm.")
        require_credentials()
        import anthropic

        targets = [
            record.text for record in records
            if args.llm_scope == "all" or classify(record.compound) != "neutral"
        ]
        unique = list(dict.fromkeys(targets))

        try:
            client = anthropic.Anthropic()
        except Exception as error:  # noqa: BLE001
            sys.exit(f"Could not build an Anthropic client: {error}")

        if args.llm_dry_run:
            sample = unique[: args.llm_batch]
            counted = client.messages.count_tokens(
                model=args.llm_model,
                system=[{"type": "text", "text": LLM_SYSTEM}],
                messages=[{"role": "user", "content": render_batch(sample)}],
            )
            batches = -(-len(unique) // args.llm_batch)
            per_batch_out = args.llm_batch * 25
            projected = Counter(
                input=counted.input_tokens * batches,
                output=per_batch_out * batches,
            )
            print(f"{len(unique)} unique prompts, {batches} batches of {args.llm_batch}")
            print(f"~{projected['input']:,} input + ~{projected['output']:,} output tokens")
            print(f"~${estimate_cost(args.llm_model, projected):.2f} on {args.llm_model} (before caching)")
            return

        cache = load_label_cache(args.llm_cache)
        cached_before = sum(1 for text in unique if label_key(text, args.llm_model) in cache)
        print(f"Labelling {len(unique) - cached_before} prompts ({cached_before} cached).", file=sys.stderr)
        try:
            cache, llm_totals, llm_failures = run_llm(
                client, args.llm_model, args.llm_effort, unique,
                args.llm_batch, args.llm_concurrency, cache,
            )
        finally:
            save_label_cache(args.llm_cache, cache)

        for record in records:
            entry = cache.get(label_key(record.text, args.llm_model))
            if entry:
                record.llm_label = entry["label"]
                record.llm_driver = entry["driver"]

    group_of = (lambda record: record.day) if args.by == "day" else (lambda record: record.model)
    if args.min_group > 1:
        sizes = Counter(group_of(record) for record in records)
        small = {name for name, count in sizes.items() if count < args.min_group}
        if small:
            base = group_of
            group_of = lambda record: "other" if base(record) in small else base(record)  # noqa: E731
            print(f"Collapsed {len(small)} group(s) under {args.min_group} prompts into 'other'.")

    buckets: dict[str, Bucket] = {}
    for record in records:
        bucket = buckets.setdefault(group_of(record), Bucket(group_of(record)))
        bucket.compounds.append(record.compound)
        bucket.whole_compounds.append(record.whole_compound)
        bucket.stock_compounds.append(record.stock_compound)
        vader_class = classify(record.compound)
        setattr(bucket, vader_class, getattr(bucket, vader_class) + 1)
        if record.llm_label:
            score = LLM_SCORES[record.llm_label]
            bucket.llm_scores.append(score)
            if score > 0:
                bucket.llm_positive += 1
            elif score < 0:
                bucket.llm_negative += 1
            else:
                bucket.llm_neutral += 1

    # Days read chronologically; models read most-used first.
    order = (
        sorted(buckets)
        if args.by == "day"
        else sorted(buckets, key=lambda name: (-len(buckets[name].compounds), name))
    )
    series = []
    for name in order:
        bucket = buckets[name]
        entry = {
            args.by: name,
            "prompts": len(bucket.compounds),
            "mean_compound": round(statistics.fmean(bucket.compounds), 4),
            "median_compound": round(statistics.median(bucket.compounds), 4),
            # Standard error of the mean. Two groups whose means differ by less than
            # the sum of their errors are not distinguishable at this sample size.
            "stderr": round(
                statistics.stdev(bucket.compounds) / len(bucket.compounds) ** 0.5, 4
            ) if len(bucket.compounds) > 1 else 0.0,
            "stock_mean_compound": round(statistics.fmean(bucket.stock_compounds), 4),
            "whole_text_mean_compound": round(statistics.fmean(bucket.whole_compounds), 4),
            "positive": bucket.positive,
            "neutral": bucket.neutral,
            "negative": bucket.negative,
        }
        if bucket.llm_scores:
            entry.update(
                llm_prompts=len(bucket.llm_scores),
                llm_mean=round(statistics.fmean(bucket.llm_scores), 4),
                llm_positive=bucket.llm_positive,
                llm_neutral=bucket.llm_neutral,
                llm_negative=bucket.llm_negative,
            )
        series.append(entry)

    total = sum(entry["prompts"] for entry in series)
    overall = sum(entry["mean_compound"] * entry["prompts"] for entry in series) / total
    stock_overall = sum(entry["stock_mean_compound"] * entry["prompts"] for entry in series) / total
    labelled = [record for record in records if record.llm_label]

    width = 12 if args.by == "day" else max(14, *(len(entry[args.by]) + 2 for entry in series))
    header = f"{args.by:<{width}}{'n':>6}{'vader':>9}{'+/-':>8}{'stock':>9}{'whole':>9}{'neg':>6}{'neu':>6}{'pos':>6}"
    if labelled:
        header += f"{'llm':>9}{'lneg':>6}{'lneu':>6}{'lpos':>6}"
    print(header)
    print("-" * len(header))
    for entry in series:
        line = (
            f"{entry[args.by]:<{width}}{entry['prompts']:>6}{entry['mean_compound']:>9.3f}"
            f"{entry['stderr']:>8.3f}{entry['stock_mean_compound']:>9.3f}"
            f"{entry['whole_text_mean_compound']:>9.3f}"
            f"{entry['negative']:>6}{entry['neutral']:>6}{entry['positive']:>6}"
        )
        if labelled:
            if "llm_mean" in entry:
                line += (
                    f"{entry['llm_mean']:>9.3f}{entry['llm_negative']:>6}"
                    f"{entry['llm_neutral']:>6}{entry['llm_positive']:>6}"
                )
            else:
                line += f"{'-':>9}{'-':>6}{'-':>6}{'-':>6}"
        print(line)
    print("-" * len(header))
    footer = (
        f"{'all':<{width}}{total:>6}{overall:>9.3f}{'':>8}{stock_overall:>9.3f}{'':>9}"
        f"{sum(e['negative'] for e in series):>6}"
        f"{sum(e['neutral'] for e in series):>6}"
        f"{sum(e['positive'] for e in series):>6}"
    )
    if labelled:
        llm_overall = statistics.fmean(LLM_SCORES[r.llm_label] for r in labelled)
        footer += (
            f"{llm_overall:>9.3f}"
            f"{sum(1 for r in labelled if LLM_SCORES[r.llm_label] < 0):>6}"
            f"{sum(1 for r in labelled if LLM_SCORES[r.llm_label] == 0):>6}"
            f"{sum(1 for r in labelled if LLM_SCORES[r.llm_label] > 0):>6}"
        )
    print(footer)

    if empty_after_clean:
        print(f"\nSkipped {empty_after_clean} prompts that were only code, paths, or URLs.")

    if labelled:
        print(f"\nClaude label distribution ({len(labelled)} prompts):")
        counts = Counter(record.llm_label for record in labelled)
        for name in LLM_LABELS:
            share = counts[name] / len(labelled) * 100
            print(f"  {name:<18}{counts[name]:>6}  {share:>5.1f}%")

        print("\nWhat drove the prompt:")
        drivers = Counter(record.llm_driver for record in labelled)
        for name, count in drivers.most_common():
            print(f"  {name:<18}{count:>6}  {count / len(labelled) * 100:>5.1f}%")

        print("\nVADER class vs Claude class:")
        matrix: dict[tuple[str, str], int] = defaultdict(int)
        for record in labelled:
            llm_class = classify(LLM_SCORES[record.llm_label])
            matrix[(classify(record.compound), llm_class)] += 1
        corner = "vader / claude"
        print(f"  {corner:<18}{'negative':>10}{'neutral':>10}{'positive':>10}")
        agreed = 0
        for vader_class in ("negative", "neutral", "positive"):
            row = [matrix[(vader_class, other)] for other in ("negative", "neutral", "positive")]
            agreed += matrix[(vader_class, vader_class)]
            print(f"  {vader_class:<18}{row[0]:>10}{row[1]:>10}{row[2]:>10}")
        print(f"  agreement: {agreed / len(labelled) * 100:.1f}%")

        if llm_failures:
            print(f"\n{llm_failures} prompts came back unlabelled.")
        if llm_totals:
            print(
                f"\nSpent {llm_totals['input'] + llm_totals['cache_read'] + llm_totals['cache_write']:,}"
                f" input / {llm_totals['output']:,} output tokens"
                f" (~${estimate_cost(args.llm_model, llm_totals):.2f} on {args.llm_model})."
            )

    if args.samples:
        ranked = sorted(records, key=lambda record: record.compound)
        print(f"\nMost negative by VADER ({args.samples}):")
        for record in ranked[: args.samples]:
            suffix = f"  [claude: {record.llm_label}]" if record.llm_label else ""
            print(f"  {record.compound:+.3f}  {record.day}  {record.text[:140]}{suffix}")
        print(f"\nMost positive by VADER ({args.samples}):")
        for record in reversed(ranked[-args.samples :]):
            suffix = f"  [claude: {record.llm_label}]" if record.llm_label else ""
            print(f"  {record.compound:+.3f}  {record.day}  {record.text[:140]}{suffix}")

    if args.disagreements and labelled:
        gap = sorted(
            labelled,
            key=lambda record: abs(record.compound - LLM_SCORES[record.llm_label]),
            reverse=True,
        )
        print(f"\nLargest VADER/Claude disagreements ({args.disagreements}):")
        for record in gap[: args.disagreements]:
            print(
                f"  vader {record.compound:+.3f} vs claude {record.llm_label:<16}"
                f" {record.day}  {record.text[:110]}"
            )

    if args.json_path:
        payload = {
            "window_days": 0 if args.today else args.days,
            "today_only": args.today,
            "group_by": args.by,
            "prompts": total,
            "overall_mean_compound": round(overall, 4),
            "stock_overall_mean_compound": round(stock_overall, 4),
            "series": series,
        }
        if labelled:
            payload["llm_model"] = args.llm_model
            payload["llm_prompts"] = len(labelled)
            payload["llm_overall_mean"] = round(
                statistics.fmean(LLM_SCORES[r.llm_label] for r in labelled), 4
            )
            payload["llm_label_counts"] = dict(Counter(r.llm_label for r in labelled))
            payload["llm_driver_counts"] = dict(Counter(r.llm_driver for r in labelled))
        with open(args.json_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        print(f"\nWrote {args.json_path}")


if __name__ == "__main__":
    main()
