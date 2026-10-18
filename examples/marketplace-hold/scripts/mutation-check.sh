#!/usr/bin/env bash
# Mutation guard for the example contract: every check wrapped in
# `// check:<name> begin` ... `// check:<name> end` is deleted in turn from a
# scratch copy, and the test suite must fail. A mutant that still passes means
# a check (or an authorization) is not covered by any test.
#
# Usage: scripts/mutation-check.sh
# Exit:  0 all mutants killed, 1 a mutant survived or the baseline is broken.
set -euo pipefail

EXAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
REL_CONTRACT="examples/marketplace-hold/contracts/marketplace-hold"
WORK="$(mktemp -d)"
TARGET_DIR="${MUTATION_TARGET_DIR:-$WORK/target}"
trap 'rm -rf "$WORK"' EXIT

SOURCES=(src/lib.rs)
SCRATCH="$WORK/$REL_CONTRACT"

copy_contract() {
  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH"
  (cd "$REPO_ROOT/$REL_CONTRACT" && tar --exclude=./target -cf - .) | (cd "$SCRATCH" && tar -xf -)
}

# The contract depends on coreflow-attest by relative path.
mkdir -p "$WORK/packages/attest"
(cd "$REPO_ROOT/packages/attest" && tar --exclude=./target -cf - .) | (cd "$WORK/packages/attest" && tar -xf -)

run_tests() {
  (cd "$SCRATCH" && CARGO_TARGET_DIR="$TARGET_DIR" cargo test --quiet >"$SCRATCH/test.log" 2>&1)
}

mapfile -t CHECKS < <(
  cd "$REPO_ROOT/$REL_CONTRACT" && grep -ho '// check:[a-z-]* begin' "${SOURCES[@]}" | sed -E 's#// check:([a-z-]*) begin#\1#' | awk '!seen[$0]++'
)
if [ "${#CHECKS[@]}" -eq 0 ]; then
  echo "no checks found" >&2
  exit 1
fi

for name in "${CHECKS[@]}"; do
  begins=$(cd "$REPO_ROOT/$REL_CONTRACT" && cat "${SOURCES[@]}" | grep -c "// check:$name begin" || true)
  ends=$(cd "$REPO_ROOT/$REL_CONTRACT" && cat "${SOURCES[@]}" | grep -c "// check:$name end" || true)
  if [ "$begins" != "$ends" ]; then
    echo "check:$name has $begins begin and $ends end markers" >&2
    exit 1
  fi
done

copy_contract
echo "baseline: unmodified contract must pass"
if ! run_tests; then
  echo "baseline FAILED; refusing to mutate" >&2
  tail -40 "$SCRATCH/test.log" >&2
  exit 1
fi

survivors=0
printf '\n%-22s %s\n' "check" "result"
printf '%-22s %s\n' "----------------------" "--------"
for name in "${CHECKS[@]}"; do
  copy_contract
  for f in "${SOURCES[@]}"; do
    awk -v n="$name" '
      $0 ~ "// check:" n " begin" { skip = 1; next }
      $0 ~ "// check:" n " end"   { skip = 0; next }
      !skip { print }
    ' "$SCRATCH/$f" >"$SCRATCH/$f.mut"
    mv "$SCRATCH/$f.mut" "$SCRATCH/$f"
  done
  if cmp -s "$REPO_ROOT/$REL_CONTRACT/src/lib.rs" "$SCRATCH/src/lib.rs"; then
    echo "check:$name removed nothing" >&2
    exit 1
  fi
  # A mutant that does not compile proves nothing about the tests.
  if ! (cd "$SCRATCH" && CARGO_TARGET_DIR="$TARGET_DIR" cargo test --quiet --no-run >"$SCRATCH/build.log" 2>&1); then
    printf '%-22s %s\n' "$name" "COMPILE-ERROR"
    tail -20 "$SCRATCH/build.log" >&2
    survivors=$((survivors + 1))
    continue
  fi
  if run_tests; then
    printf '%-22s %s\n' "$name" "SURVIVED"
    survivors=$((survivors + 1))
  else
    printf '%-22s %s\n' "$name" "KILLED"
  fi
done

echo
if [ "$survivors" -gt 0 ]; then
  echo "$survivors mutant(s) survived or failed to compile" >&2
  exit 1
fi
echo "all ${#CHECKS[@]} mutants killed"
