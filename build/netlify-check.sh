#!/bin/bash
# Deploy-blocking rules Netlify enforces. Run this BEFORE shipping a zip —
# these fail the build, not the tests, so nothing else catches them.
cd "$(dirname "$0")/../netlify/functions" || exit 1
fail=0

echo "  [1] scheduled functions must not declare a custom path"
for f in *.js; do
  cfg=$(grep -o 'export const config = {[^}]*}' "$f" 2>/dev/null)
  [ -z "$cfg" ] && continue
  if echo "$cfg" | grep -q 'schedule:' && echo "$cfg" | grep -q 'path:'; then
    echo "      FAIL $f -> $cfg"; fail=1
  fi
done
[ $fail -eq 0 ] && echo "      ok"

echo "  [2] no two functions may claim the same path"
dup=$(grep -ho 'path: *"[^"]*"' *.js | sed 's/path: *"//;s/"//' | sort | uniq -d)
if [ -n "$dup" ]; then echo "      FAIL duplicate: $dup"; fail=1; else echo "      ok"; fi

echo "  [3] every function must parse as an ES module"
for f in *.js; do
  node --input-type=module -e "$(cat "$f")" >/dev/null 2>&1 || node --check "$f" >/dev/null 2>&1 || { echo "      FAIL $f"; fail=1; }
done
[ $fail -eq 0 ] && echo "      ok"

echo "  [4] relative imports must resolve"
for f in *.js; do
  grep -o 'from "\./[A-Za-z0-9_.-]*\.js"' "$f" | sed 's/from "\.\///;s/"//' | while read -r t; do
    [ -f "$t" ] || { echo "      FAIL $f -> $t"; exit 1; }
  done || fail=1
done
[ $fail -eq 0 ] && echo "      ok"

echo
[ $fail -eq 0 ] && echo "  ✓ deploy checks passed" || echo "  ✗ deploy would fail"
exit $fail
