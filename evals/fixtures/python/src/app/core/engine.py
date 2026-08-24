"""Scoring engine: computes scores and persists them through the store."""

from typing import Any

import yaml

from app.store.db import save_result

with open("weights.yaml") as handle:
    WEIGHTS: dict[str, Any] = yaml.safe_load(handle)


def score(name: str, features: dict[str, float]) -> float:
    value = sum(WEIGHTS.get(key, 0.0) * feature for key, feature in features.items())
    save_result(name, value)
    return value
