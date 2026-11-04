#!/bin/sh
# Pre-push guard: `scripts/changed.sh <dir> || <checks>`. Exit 0 means skip the checks, and it is
# only ever printed when every pushed commit was compared to the merge-base of origin/main without
# a git error and none changed anything under <dir>. Anything else (no origin/main, shallow clone,
# git failing, unparsable input) exits 1 so the checks run.
#
# The pre-push hook gets `<local ref> <local oid> <remote ref> <remote oid>` lines on stdin, one
# per pushed ref. Those are what is being pushed, which is not necessarily HEAD. Without stdin
# lines (run by hand, or a terminal) HEAD is compared.
dir=$1
[ -n "$dir" ] || exit 1
top=$(git rev-parse --show-toplevel) || exit 1
[ "$(git -C "$top" rev-parse --is-shallow-repository)" = false ] || exit 1

unchanged() {
  base=$(git -C "$top" merge-base origin/main "$1") || return 1
  changed=$(git -C "$top" diff --name-only "$base".."$1" -- "$dir") || return 1
  [ -z "$changed" ]
}

input=
[ -t 0 ] || input=$(cat)
if [ -z "$(printf '%s' "$input" | tr -d ' \t\n')" ]; then
  unchanged HEAD
  exit $?
fi

# The all-zero oid has the hash length of the repo's object format (sha1 or sha256).
zero=$(git hash-object --stdin </dev/null | tr '0-9a-f' '0') || exit 1
printf '%s\n' "$input" | while read -r _ref oid _rest; do
  [ -n "$_ref$oid" ] || continue
  case $oid in
    "" | *[!0-9a-f]*) exit 1 ;;
  esac
  [ ${#oid} -eq ${#zero} ] || exit 1
  [ "$oid" = "$zero" ] && continue
  unchanged "$oid" || exit 1
done
