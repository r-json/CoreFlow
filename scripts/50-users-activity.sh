#!/usr/bin/env bash
# ============================================================================
# Reads the first 50 names from the CoreFlow feedback CSV, generates Stellar
# testnet keypairs (using each user's slugified name as the identity),
# funds them via Friendbot, and invokes the Doqtri provenance contract
# (register_document, update_document, set_node_status) for each user.
#
# Output: a TSV file with index, name, wallet, doc ID, and 3 tx hashes.
#
# Usage:
#   chmod +x scripts/50-users-activity.sh
#   ./scripts/50-users-activity.sh
#
# Environment overrides (all optional):
#   CSV_FILE=/path/to/file.csv   — input CSV
#   OUT=/path/to/output.tsv      — output TSV
#   VERSION=v3                   — doc-ID version suffix
#   MAX_USERS=20                 — cap user count
#
# Re-run safety:
#   - Existing keys are NOT regenerated (stellar keys generate is skipped).
#   - Already-completed rows in the TSV are skipped on re-run.
#   - Bump VERSION to v3, v4, … if doc IDs collide from a prior run.
# ============================================================================
set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────

# Contract ID from the Doqtri deployment guide
CONTRACT="${CONTRACT:-CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB}"

# Version suffix for document IDs — bump on re-runs to avoid collisions
VERSION="${VERSION:-v2}"

# Max number of users to process
MAX_USERS="${MAX_USERS:-50}"

# Delay between Friendbot funding requests (seconds) to avoid rate-limits
FUND_DELAY=2

# Input CSV — defaults to the feedback CSV in data/
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CSV_FILE="${CSV_FILE:-$PROJECT_ROOT/data/50-users-feedback.csv}"

# Output TSV
OUT="${OUT:-/tmp/50-users-activity.tsv}"

# ─── Preflight checks ──────────────────────────────────────────────────────

if ! command -v stellar &>/dev/null; then
  echo "ERROR: 'stellar' CLI not found. Install it first:"
  echo "  cargo install --locked stellar-cli"
  echo "  # or: brew install stellar-cli"
  exit 1
fi

if [[ ! -f "$CSV_FILE" ]]; then
  echo "ERROR: CSV file not found: $CSV_FILE"
  echo "  Set CSV_FILE=/path/to/your.csv to override."
  exit 1
fi

echo "============================================"
echo "  Doqtri 50-User Testnet Load Simulation"
echo "============================================"
echo "  Contract : $CONTRACT"
echo "  Version  : $VERSION"
echo "  CSV      : $CSV_FILE"
echo "  Output   : $OUT"
echo "  Max users: $MAX_USERS"
echo "============================================"
echo ""

# ─── Helper: slugify a name ────────────────────────────────────────────────
# Lowercase, spaces/tabs → hyphens, strip everything except [a-z0-9-],
# collapse multiple hyphens, trim leading/trailing hyphens.
slugify() {
  LC_ALL=C printf '%s' "$1" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed 's/[[:space:]]\+/-/g' \
    | LC_ALL=C sed 's/[^a-z0-9-]//g' \
    | LC_ALL=C sed 's/-\+/-/g' \
    | LC_ALL=C sed 's/^-//;s/-$//'
}

# ─── Step 1: Extract names from CSV ────────────────────────────────────────
# New CSV columns: Name,Email Address,Wallet Address,Product Rating,Product Feedback
# Name is column 1 (first field). Skip the header row.
# We also strip any trailing carriage returns (\r) from the CSV.

echo ">>> Reading names from CSV …"
mapfile -t NAMES < <(
  tail -n +2 "$CSV_FILE" \
    | head -n "$MAX_USERS" \
    | cut -d',' -f1 \
    | sed 's/\r$//' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
)

TOTAL=${#NAMES[@]}
echo "    Found $TOTAL names (capped at $MAX_USERS)."
echo ""

if [[ $TOTAL -eq 0 ]]; then
  echo "ERROR: No names extracted from CSV."
  exit 1
fi

# ─── Build slug array & display the roster ──────────────────────────────────

declare -a SLUGS
echo ">>> User roster:"
for i in $(seq 1 "$TOTAL"); do
  name="${NAMES[$((i-1))]}"
  slug=$(slugify "$name")
  SLUGS+=("$slug")
  printf "    %2d. %-35s → %s\n" "$i" "$name" "$slug"
done
echo ""

# ─── Step 2: Generate keypairs (skip if key already exists) ─────────────────
# Uses the slug as the Stellar key identity (e.g. "clark-bautista")
# so identities are human-readable and tied to the actual user name.

echo ">>> Step 1/3: Generating keypairs …"
for i in $(seq 1 "$TOTAL"); do
  slug="${SLUGS[$((i-1))]}"
  # Check if key already exists by trying to get its address
  if stellar keys address "$slug" &>/dev/null; then
    echo "    [$i/$TOTAL] Key '$slug' already exists — skipping."
  else
    echo "    [$i/$TOTAL] Generating key '$slug' …"
    stellar keys generate "$slug" --network testnet
  fi
done
echo "    ✓ All $TOTAL keypairs ready."
echo ""

# ─── Step 3: Fund keys via Friendbot ───────────────────────────────────────

echo ">>> Step 2/3: Funding keypairs via Friendbot …"
for i in $(seq 1 "$TOTAL"); do
  slug="${SLUGS[$((i-1))]}"
  echo -n "    [$i/$TOTAL] Funding '$slug' … "
  # Friendbot funding is idempotent — already-funded accounts error harmlessly
  if stellar keys fund "$slug" --network testnet 2>&1; then
    echo "✓"
  else
    echo "⚠ (may already be funded — continuing)"
  fi
  # Rate-limit delay between requests
  if [[ $i -lt $TOTAL ]]; then
    sleep "$FUND_DELAY"
  fi
done
echo "    ✓ Funding complete."
echo ""

# ─── Step 4: Build the completion set for idempotency ──────────────────────
# If the output TSV already has rows, record which indices are done so we
# can skip them on a re-run. This makes the script safe to restart midway.

declare -A DONE_SET
if [[ -f "$OUT" ]]; then
  while IFS=$'\t' read -r idx rest; do
    # Skip empty lines or non-numeric indices
    [[ "$idx" =~ ^[0-9]+$ ]] && DONE_SET[$idx]=1
  done < "$OUT"
  DONE_COUNT=${#DONE_SET[@]}
  if [[ $DONE_COUNT -gt 0 ]]; then
    echo "    ℹ Found $DONE_COUNT already-completed rows in $OUT — will skip."
  fi
else
  # Create the file fresh
  : > "$OUT"
fi
echo ""

# ─── Step 5: Run the simulation loop ──────────────────────────────────────

echo ">>> Step 3/3: Running contract invocations …"
echo "    (3 invocations per user × $TOTAL users = $((TOTAL * 3)) total txns)"
echo "    Estimated time: $((TOTAL * 3 * 6 / 60))–$((TOTAL * 3 * 8 / 60)) minutes"
echo ""

for i in $(seq 1 "$TOTAL"); do
  # Skip already-completed users (idempotency)
  if [[ -n "${DONE_SET[$i]:-}" ]]; then
    echo "    [$i/$TOTAL] Already done — skipping."
    continue
  fi

  # Get the name and slug (0-indexed array, so index is i-1)
  name="${NAMES[$((i-1))]}"
  slug="${SLUGS[$((i-1))]}"
  doc="${slug}-plan-${VERSION}"
  addr=$(stellar keys address "$slug")

  # Deterministic hashes from the guide
  hash1=$(printf '%064d' $((200 + i)))        # e.g. 000…0201
  hash2=$(printf '%064x' $((0x4000 + i)))      # e.g. 000…4001

  echo "═══════════════════════════════════════════"
  echo "  [$i/$TOTAL] $name"
  echo "  Key  : $slug"
  echo "  Addr : $addr"
  echo "  Doc  : $doc"
  echo "  Hash1: ${hash1:0:8}…${hash1: -8}"
  echo "  Hash2: ${hash2:0:8}…${hash2: -8}"
  echo "═══════════════════════════════════════════"

  # ── 1) register_document ──────────────────────────────────────────────
  echo -n "    1/3 register_document … "
  reg=$(stellar contract invoke \
    --id "$CONTRACT" \
    --source "$slug" \
    --network testnet -- \
    register_document \
      --owner "$slug" \
      --doc_id "$doc" \
      --content_hash "$hash1" 2>&1) || true
  reg_tx=$(echo "$reg" | grep -oE '[a-f0-9]{64}' | head -1 || echo "")
  if [[ -n "$reg_tx" ]]; then
    echo "✓ tx=$reg_tx"
  else
    echo "⚠ no tx hash captured"
    echo "    Full output: $(echo "$reg" | head -3)"
  fi

  # ── 2) update_document ────────────────────────────────────────────────
  echo -n "    2/3 update_document … "
  upd=$(stellar contract invoke \
    --id "$CONTRACT" \
    --source "$slug" \
    --network testnet -- \
    update_document \
      --doc_id "$doc" \
      --new_hash "$hash2" 2>&1) || true
  upd_tx=$(echo "$upd" | grep -oE '[a-f0-9]{64}' | head -1 || echo "")
  if [[ -n "$upd_tx" ]]; then
    echo "✓ tx=$upd_tx"
  else
    echo "⚠ no tx hash captured"
    echo "    Full output: $(echo "$upd" | head -3)"
  fi

  # ── 3) set_node_status ────────────────────────────────────────────────
  echo -n "    3/3 set_node_status … "
  node=$(stellar contract invoke \
    --id "$CONTRACT" \
    --source "$slug" \
    --network testnet -- \
    set_node_status \
      --doc_id "$doc" \
      --node_id "ship" \
      --status Built \
      --tool "n8n" \
      --artifact_ref "wf_${slug}" 2>&1) || true
  node_tx=$(echo "$node" | grep -oE '[a-f0-9]{64}' | head -1 || echo "")
  if [[ -n "$node_tx" ]]; then
    echo "✓ tx=$node_tx"
  else
    echo "⚠ no tx hash captured"
    echo "    Full output: $(echo "$node" | head -3)"
  fi

  # ── Append TSV row ────────────────────────────────────────────────────
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$i" "$name" "$addr" "$doc" \
    "${reg_tx:-FAILED}" "${upd_tx:-FAILED}" "${node_tx:-FAILED}" >> "$OUT"

  echo ""
done

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  SIMULATION COMPLETE"
echo "============================================"
echo ""

# Count successful rows (all 3 tx hashes are 64-char hex)
TOTAL_ROWS=$(wc -l < "$OUT")
SUCCESS=$(awk -F'\t' '$5 ~ /^[a-f0-9]{64}$/ && $6 ~ /^[a-f0-9]{64}$/ && $7 ~ /^[a-f0-9]{64}$/' "$OUT" | wc -l)
FAILED=$((TOTAL_ROWS - SUCCESS))

echo "  Total users processed : $TOTAL_ROWS"
echo "  Fully successful      : $SUCCESS"
echo "  Partial/failed        : $FAILED"
echo "  Total transactions    : $((SUCCESS * 3)) confirmed + $((FAILED * 3)) partial"
echo "  Output file           : $OUT"
echo ""

# Print the TSV to console
echo "─── TSV Output ───────────────────────────────────────────────────────"
printf '#\tName\tWallet\tDoc ID\tRegister TX\tUpdate TX\tNode TX\n'
cat "$OUT"
echo "─────────────────────────────────────────────────────────────────────"
echo ""

# Copy to project evidence directory as well
EVIDENCE_DIR="$PROJECT_ROOT/docs/evidence"
if [[ -d "$EVIDENCE_DIR" ]]; then
  cp "$OUT" "$EVIDENCE_DIR/50-users-activity.tsv"
  echo "  ✓ Also saved to: $EVIDENCE_DIR/50-users-activity.tsv"
fi

echo ""
echo "Verify a document:"
echo "  stellar contract invoke --id $CONTRACT --source \"${SLUGS[0]}\" --network testnet -- get_document --doc_id \"${SLUGS[0]}-plan-${VERSION}\""
echo ""
echo "Explore a tx on Stellar Expert:"
echo "  https://stellar.expert/explorer/testnet/tx/<HASH>"
echo ""
