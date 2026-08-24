"""Result store: persists and serves scoring results."""

from pathlib import Path

RESULTS = Path("results")


def save_result(name: str, score: float) -> None:
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / name).write_text(str(score))


def latest_result(name: str) -> float:
    return float((RESULTS / name).read_text())
