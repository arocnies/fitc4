"""HTTP API: parses requests and answers with scores."""

import json

from app.core.engine import score
from app.store.db import latest_result


def post_score(body: str) -> str:
    request = json.loads(body)
    return json.dumps({"score": score(request["name"], request["features"])})


def get_score(name: str) -> str:
    # Reads the store directly instead of asking the engine.
    return json.dumps({"score": latest_result(name)})
