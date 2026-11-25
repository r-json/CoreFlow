#!/usr/bin/env bash
# Mutation guard: every check wrapped in `// check:<name> begin` ... `// check:<name> end`
# is deleted in turn from a scratch copy of the crate, and the test suite must
# fail. A mutant that still passes means a check is not covered by any test.
#
# Usage: scripts/mutation-check.sh
# Exit:  0 all mutants killed, 1 a mutant survived or the baseline is broken.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
TARGET_DIR="${MUTATION_TARGET_DIR:-$WORK/target}"
trap 'rm -rf "$WORK"' EXIT

SOURCES=(src/verify.rs src/replay.rs src/registry.rs src/storage.rs)

copy_crate() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  (cd "$CRATE_DIR" && tar --exclude=./target -cf - .) | (cd "$dest" && tar -xf -)
  # The vectors test reads ../test-vectors relative to the crate.
  mkdir -p "$dest/../test-vectors"
  cp -r "$CRATE_DIR/../test-vectors/vectors" "$dest/../test-vectors/"
}

run_tests() {
  (cd "$1" && CARGO_TARGET_DIR="$TARGET_DIR" cargo test --quiet --all-features >"$1/test.log" 2>&1)
}

# Names of all marked checks, in file order.
mapfile -t CHECKS < <(
  cd "$CRATE_DIR" && grep -ho '// check:[a-z-]* begin' "${SOURCES[@]}" | sed -E 's#// check:([a-z-]*) begin#\1#' | awk '!seen[$0]++'
)
if [ "${#CHECKS[@]}" -eq 0 ]; then
  echo "no checks found" >&2
  exit 1
fi

# Every begin must have a matching end.
for name in "${CHECKS[@]}"; do
  begins=$(cd "$CRATE_DIR" && cat "${SOURCES[@]}" | grep -c "// check:$name begin" || true)
  ends=$(cd "$CRATE_DIR" && cat "${SOURCES[@]}" | grep -c "// check:$name end" || true)
  if [ "$begins" != "$ends" ]; then
    echo "check:$name has $begins begin and $ends end markers" >&2
    exit 1
  fi
done

SCRATCH="$WORK/crate/packages/attest"
copy_crate "$SCRATCH"

echo "baseline: unmodified crate must pass"
if ! run_tests "$SCRATCH"; then
  echo "baseline FAILED; refusing to mutate" >&2
  tail -40 "$SCRATCH/test.log" >&2
  exit 1
fi

survivors=0
printf '\n%-22s %s\n' "check" "result"
printf '%-22s %s\n' "----------------------" "--------"
for name in "${CHECKS[@]}"; do
  copy_crate "$SCRATCH"
  for f in "${SOURCES[@]}"; do
    awk -v n="$name" '
      $0 ~ "// check:" n " begin" { skip = 1; next }
      $0 ~ "// check:" n " end"   { skip = 0; next }
      !skip { print }
    ' "$SCRATCH/$f" >"$SCRATCH/$f.mut"
    mv "$SCRATCH/$f.mut" "$SCRATCH/$f"
  done
  if cmp -s <(cd "$CRATE_DIR" && cat "${SOURCES[@]}") <(cd "$SCRATCH" && cat "${SOURCES[@]}"); then
    echo "check:$name removed nothing" >&2
    exit 1
  fi
  # A mutant that does not compile proves nothing about the tests.
  if ! (cd "$SCRATCH" && CARGO_TARGET_DIR="$TARGET_DIR" cargo test --quiet --all-features --no-run >"$SCRATCH/build.log" 2>&1); then
    printf '%-22s %s\n' "$name" "COMPILE-ERROR"
    tail -20 "$SCRATCH/build.log" >&2
    survivors=$((survivors + 1))
    continue
  fi
  if run_tests "$SCRATCH"; then
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
