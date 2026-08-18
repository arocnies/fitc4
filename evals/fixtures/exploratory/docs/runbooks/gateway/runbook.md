# Gateway runbook

The gateway accepts job submissions. It holds no state of its own: every
accepted job is handed straight to the worker.

## Submissions time out

1. Check the gateway health endpoint on the affected node.
2. Restart the gateway process.
3. Drain the held submissions back into the worker queue so no accepted job is lost.
