# Worker runbook

The worker executes jobs. It is the only service that is allowed to touch
the result store.

## Jobs stuck in running

1. Inspect the worker queue depth.
2. Requeue the stuck jobs; the worker writes every finished result into the store.
3. If more than 100 jobs had to be requeued, the worker raises a page through alerts.
