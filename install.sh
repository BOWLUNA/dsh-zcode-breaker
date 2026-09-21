#!/usr/bin/env bash
# Install dsh-zcode-breaker into a dsh profile.
#
# Usage:
#   ./install.sh                    # web profile
#   ./install.sh --profile headless
#
# Unlike a bundle plugin, this package has no cordis.patch.yml: it is mounted by
# a row inside an agent preset, not as a profile layer. Installing it therefore
# only makes it resolvable — the preset edit below is what turns it on. The
# installer says so rather than letting the warning about a missing `dsh.bundle`
# look like a failed install.
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
	echo "  Desktop builds ship it inside the app rather than linking it; see the README." >&2
	exit 1
}

if [ -z "${DSH_HOME:-}" ]; then
	echo "warning: DSH_HOME is unset — the CLI will resolve the harness data directory on its own." >&2
	echo "         If the plugin does not show up afterwards, set DSH_HOME and re-run." >&2
fi

# Read the package name from the manifest rather than hard-coding it, so a
# rename cannot leave the script installing something that no longer exists.
PKG_NAME="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$ROOT/package.json")"

echo "installing ${PKG_NAME} into the ${PROFILE} profile"
dsh plugin --profile "$PROFILE" add "$ROOT"

echo ""
echo "Installed. One manual step remains, because this plugin is activated by a"
echo "preset row rather than by a profile layer:"
echo ""
echo "  In your agent preset's agent.cordis.yml, inside the group declared"
echo "  isolate: { compaction: true, ... }, replace the row"
echo ""
echo "      - id: compaction-basic"
echo "        name: '@deepseek-ai/dsh-compaction-basic'"
echo ""
echo "  with"
echo ""
echo "      - id: compaction-breaker"
echo "        name: '${PKG_NAME}'"
echo ""
echo "  Copy the preset into your user preset directory before editing it, so a"
echo "  harness upgrade does not overwrite the change. See docs/ARCHITECTURE.md."
