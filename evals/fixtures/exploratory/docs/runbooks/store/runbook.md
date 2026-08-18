# Store runbook

The store keeps durable job results. Recovery is local: nothing in this
runbook reaches out to another service.

## Restore from backup

1. Stop the store.
2. Restore the latest snapshot from local disk.
3. Start the store and verify row counts before reopening traffic.
