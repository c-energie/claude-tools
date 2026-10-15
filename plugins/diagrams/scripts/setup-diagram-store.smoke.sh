#!/usr/bin/env bash
# Smoke test for setup-diagram-store.mjs: every step twice, then one case per guardrail.
#
#   bash plugins/diagrams/scripts/setup-diagram-store.smoke.sh
#
# Throwaway dirs under mktemp only. Origins are fake github.com URLs whose PUSH url is a local
# bare repo, so nothing leaves the machine. Needs git, node and a gh login: three cases read
# GitHub (gh repo view on c-energie/diagrams and cli/cli) and create nothing.
S="$(cd "$(dirname "$0")" && pwd)/setup-diagram-store.mjs"
T=$(mktemp -d)
unset DIAGRAMS_STORE DIAGRAMS_CROSS_ORG CONTEXT_CONFIG
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mk() { git init -q -b main "$1"; git -C "$1" remote add origin "https://github.com/$2.git"; git init -q --bare "$1-bare.git"; git -C "$1" remote set-url --push origin "$1-bare.git"; }
proj() { mk "$1" "$2"; mkdir -p "$1/docs"; echo hi > "$1/docs/a.txt"; git -C "$1" add -A 2>/dev/null; git -C "$1" commit -qm init; git -C "$1" push -q -u origin main 2>/dev/null; git -C "$1" fetch -q 2>/dev/null; git -C "$1" branch -q -u origin/main 2>/dev/null; }
mk "$T/store" test-org/diagrams
proj "$T/proj" test-org/proj
export DIAGRAM_STORE_DIR="$T/store"
R="--root $T/proj"
ok=0; fail=0
t() { local want=$1; local grepfor=$2; shift 2; out=$(node "$S" "$@" 2>&1); rc=$?; r=PASS
  if [ "$rc" != "$want" ]; then r="FAIL(rc=$rc want $want)"; elif [ -n "$grepfor" ] && ! grep -q -- "$grepfor" <<<"$out"; then r="FAIL(no '$grepfor')"; fi
  if [ "$r" = PASS ]; then ok=$((ok+1)); else fail=$((fail+1)); fi
  echo "[$r] $*"; [ "$r" != PASS ] && echo "$out" | sed 's/^/    /'; }
check() { if eval "$2"; then ok=$((ok+1)); echo "[PASS] $1"; else fail=$((fail+1)); echo "[FAIL] $1"; fi; }

echo "== happy path, each step twice"
for i in 1 2; do
  t 0 "" $R --dry-run store --mode local --repo test-org/diagrams --dir "$T/store"
  t 0 "^OK" $R store --mode local --repo test-org/diagrams --dir "$T/store"            # #1 OK on reuse
  t 0 "" $R --dry-run stamp --dir "$T/store"
  t 0 "^OK" $R stamp --dir "$T/store"
  t 0 "^OK" $R push-store --dir "$T/store"
  t 0 "" $R --dry-run config --target repo-file --repo test-org/diagrams --project Proj
  t 0 "^OK" $R config --target repo-file --repo test-org/diagrams --project Proj
  t 0 "^OK" $R commit-config --target repo-file
  t 0 "^OK" $R push-config --target repo-file
  t 0 "^OK.*2 working directories" $R prove
done
t 0 "STATE set-up" $R check

echo "== #2 ~ expansion and nesting"
t 2 "inside the project" $R store --mode fresh --repo test-org/x --dir "$T/proj/nested"
mkdir -p "$T/proj/sub"
t 2 "inside the project" $R store --mode adopt --repo test-org/x --dir "$T/proj/sub/x"
out=$(node "$S" --root "~" --dry-run check 2>&1 | grep "root ")
check "--root ~ expands to home" '[[ "$out" == *"$(cygpath -w "$HOME" 2>/dev/null || echo "$HOME")"* ]]'
check "no literal ~ dir created in project" '[ ! -e "$T/proj/~" ]'
t 2 "is not a directory" --root "$T/missing" check                                  # #9 missing root

echo "== #5 env does not count as set up; config refuses before writing (#18)"
proj "$T/p5" test-org/p5
DIAGRAMS_STORE=test-org/diagrams t 0 "STATE unnamed" --root "$T/p5" check
DIAGRAMS_STORE=test-org/elsewhere t 2 "DIAGRAMS_STORE is set" --root "$T/p5" config --target repo-file --repo test-org/diagrams
check "#18 nothing written on refusal" '[ ! -e "$T/p5/.diagrams.json" ]'
DIAGRAMS_STORE=test-org/diagrams t 2 "DIAGRAMS_STORE is set" --root "$T/p5" prove

echo "== #6 existing config that cannot work is refused, not kept"
proj "$T/p6" test-org/p6
echo '{ "repo": "other-org/diagrams" }' > "$T/p6/.diagrams.json"
t 2 "lacks \"crossOrg\": true" --root "$T/p6" config --target repo-file --repo other-org/diagrams --cross-org
echo '{ "project": "x" }' > "$T/p6/.diagrams.json"
t 2 "names no \"repo\"" --root "$T/p6" config --target repo-file --repo test-org/diagrams
printf '\xEF\xBB\xBF{ "repo": "test-org/diagrams" }' > "$T/p6/.diagrams.json"
t 0 "^OK" --root "$T/p6" config --target repo-file --repo test-org/diagrams          # BOM tolerated (#11)
echo '{ broken' > "$T/p6/.diagrams.json"
t 1 "FAILED:" --root "$T/p6" config --target repo-file --repo test-org/diagrams      # #11 prefix

echo "== #7 stamp commits only what it writes"
mk "$T/s7" test-org/s7
echo "user readme" > "$T/s7/README.md"; echo staged > "$T/s7/other.txt"; git -C "$T/s7" add other.txt
DIAGRAM_STORE_DIR= t 1 "not tracked by git: README.md" $R stamp --dir "$T/s7"     # #16: user's README untracked → reported
check "#7 user's staged file not committed" '[ -z "$(git -C "$T/s7" log --format=%H -- other.txt 2>/dev/null)" ]'
check "#7 user's README not overwritten" 'grep -q "user readme" "$T/s7/README.md"'

echo "== #8 push-config refuses extra commits"
proj "$T/p8" test-org/p8
t 0 "^OK" --root "$T/p8" config --target repo-file --repo test-org/diagrams
echo x > "$T/p8/unrelated.txt"; git -C "$T/p8" add unrelated.txt; git -C "$T/p8" commit -qm "unrelated work"
t 0 "^OK" --root "$T/p8" commit-config --target repo-file
t 2 "unpushed commit" --root "$T/p8" push-config --target repo-file
check "#8 nothing pushed" '[ "$(git -C "$T/p8" rev-list --count @{u}..HEAD)" = 2 ]'

echo "== #9 repo-file only at the repo root"
t 2 "not a repo root" --root "$T/proj/docs" config --target repo-file --repo test-org/diagrams

echo "== #10 named but refused"
proj "$T/p10" test-org/p10
echo '{ "repo": "other-org/diagrams" }' > "$T/p10/.diagrams.json"
t 0 "STATE named-refused" --root "$T/p10" check

echo "== #12 context: nested null untouched, sub-keys kept"
proj "$T/p12" test-org/p12
printf '{\n  "project": "Ctx",\n  "contextRepo": "test-org/ctx",\n  "connections": { "x": { "state": null } },\n  "state": null\n}\n' > "$T/ctx12.json"
CONTEXT_CONFIG="$T/ctx12.json" t 0 "^OK" --root "$T/p12" config --target context --repo test-org/diagrams
check "#12 nested state:null kept" 'grep -q "\"x\":{\"state\":null}\|\"x\": {\s*\"state\": null" "$T/ctx12.json" || node -e "process.exit(require(process.argv[1]).connections.x.state===null?0:1)" "$T/ctx12.json"'
printf '{ "project": "C", "contextRepo": "test-org/ctx", "state": { "notion": 1, "diagrams": { "org": "Keep" } } }\n' > "$T/ctx12b.json"
CONTEXT_CONFIG="$T/ctx12b.json" t 0 "^OK" --root "$T/p12" config --target context --repo test-org/diagrams
check "#12 state.diagrams.org kept, state.notion kept" 'node -e "const j=require(process.argv[1]);process.exit(j.state.diagrams.org===\"Keep\"&&j.state.notion===1&&j.state.diagrams.repo===\"test-org/diagrams\"?0:1)" "$T/ctx12b.json"'

echo "== #14 fresh/adopt edge cases"
mkdir -p "$T/s14a"; git init -q -b main "$T/s14a"; echo x > "$T/s14a/f"; git -C "$T/s14a" add f; git -C "$T/s14a" commit -qm x
t 2 "with commits and no origin" $R store --mode fresh --repo test-org/s14 --dir "$T/s14a"
git init -q -b main "$T/s14b"
t 2 "empty git repo with no origin" $R store --mode adopt --repo test-org/s14 --dir "$T/s14b"
t 2 "already exists on GitHub" $R store --mode fresh --repo c-energie/diagrams --dir "$T/s14c"

echo "== #13 public store refused without --public-ok"
t 2 "is public" $R store --mode adopt --repo cli/cli --dir "$T/s13"
t 0 "" $R --dry-run store --mode adopt --repo cli/cli --dir "$T/s13" --public-ok

echo "== #15 prove with a closed status list"
printf '{ "types": [], "tags": [], "statuses": ["draft", "final"] }\n' > "$T/store/taxonomy.json"
t 0 "^OK" $R prove
rm "$T/store/taxonomy.json"

echo "== #4 config fails when the checkout it points at is missing"
proj "$T/p4" test-org/p4
DIAGRAM_STORE_DIR= t 1 "no checkout at" --root "$T/p4" config --target repo-file --repo test-org/diagrams

echo "== earlier guardrails"
t 2 "not test-org/other\|is a checkout of" $R store --mode local --repo other-org/x --dir "$T/store"
mkdir -p "$T/junk"; echo x > "$T/junk/f"
t 2 "is not empty" $R store --mode adopt --repo test-org/diagrams --dir "$T/junk"
t 2 "existing checkout" $R store --mode local --repo test-org/diagrams --dir "$T/missing"
t 2 "already names" $R config --target repo-file --repo test-org/other
proj "$T/proj2" test-org/proj2
t 2 "belongs to other-org" --root "$T/proj2" config --target repo-file --repo other-org/diagrams
t 0 "^OK" --root "$T/proj2" config --target repo-file --repo other-org/diagrams --cross-org
check "crossOrg recorded" 'grep -q "\"crossOrg\": true" "$T/proj2/.diagrams.json"'
t 2 "not inside a git repo" --root "$T" config --target repo-file --repo test-org/diagrams
t 2 "takes no --dir" $R config --target repo-file --repo test-org/diagrams --dir "$T/store"
t 2 "REFUSED: unknown step" $R nonsense
sha=$(sha256sum "$T/store/index.jsonl")
t 0 "^OK" $R prove
check "index unchanged by prove" '[ "$sha" = "$(sha256sum "$T/store/index.jsonl")" ]'

echo; echo "passed $ok, failed $fail"; rm -rf "$T"
[ "$fail" = 0 ]
