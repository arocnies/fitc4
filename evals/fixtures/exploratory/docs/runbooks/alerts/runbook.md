# Alerts runbook

Alerts pages the on-call engineer. It is fed page requests by the worker
and keeps a short-lived cache of recent pages.

## A page was lost

1. Check the alerts cache for the page id.
2. If the cache is empty, query the result store directly for the failing job's record and re-page from it.
