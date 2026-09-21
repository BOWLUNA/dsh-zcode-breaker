#!/usr/bin/env bash
# Uninstall dsh-zcode-breaker from a dsh profile.
#
# Usage:
#   ./uninstall.sh                    # web profile
#   ./uninstall.sh --profile headless
#
# An install with no uninstall is rude: the plugin replaces a row inside an
# agent preset, and leaving that row behind after removing the package turns
# every session into a broken preset. So this script also tells you to put the
# row back, which is the half a package manager cannot do for you.
set -euo pipefail

PROFILE=web
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
	case "$1" in
		--profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
		-h | --help) sed -n '2,10p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

command -v dsh >/dev/null 2>&1 || {
	echo "error: the dsh CLI is not on PATH." >&2
	exit 1
}

PKG_NAME="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$ROOT/package.json")"

echo "removing ${PKG_NAME} from the ${PROFILE} profile"
dsh plugin --profile "$PROFILE" remove "$PKG_NAME"

echo ""
echo "Removed. Restore the preset row you replaced, or the preset will reference"
echo "a package that no longer exists:"
echo ""
echo "      - id: compaction-basic"
echo "        name: '@deepseek-ai/dsh-compaction-basic'"
echo ""
echo "Check with: dsh --profile ${PROFILE} --dump-config"
