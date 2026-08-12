# CoreFlow 50-User Activity Simulation

## Scope

The live testnet simulation reads 50 user names from [`data/50-users-feedback.csv`](../data/50-users-feedback.csv), generates Stellar testnet keypairs, funds them via Friendbot, and invokes the Doqtri provenance contract for each user:

1. `register_document`
2. `update_document`
3. `set_node_status`

The script is idempotent — existing keys and already-completed rows are skipped on re-run.

## Run the live simulation

From the repository root:

```bash
chmod +x scripts/50-users-activity.sh
./scripts/50-users-activity.sh
```

### Environment overrides (all optional)

| Variable     | Default                                              | Description           |
| ------------ | ---------------------------------------------------- | --------------------- |
| `CSV_FILE`   | `data/50-users-feedback.csv`                         | Input CSV             |
| `OUT`        | `/tmp/50-users-activity.tsv`                         | Output TSV            |
| `VERSION`    | `v2`                                                 | Doc-ID version suffix |
| `MAX_USERS`  | `50`                                                 | Cap user count        |

## Output

- `/tmp/50-users-activity.tsv` — primary output with index, name, wallet, doc ID, and 3 transaction hashes
- `docs/evidence/50-users-activity.tsv` — copy saved to the project evidence directory (if the directory exists)

## Verify results

Check a registered document:

```bash
stellar contract invoke --id <CONTRACT_ID> --source "<slug>" --network testnet -- get_document --doc_id "<slug>-plan-v2"
```

Explore a transaction on Stellar Expert:

```
https://stellar.expert/explorer/testnet/tx/<HASH>
```
