#!/usr/bin/env bash
#
# Launch the desktop app with the environment the harness needs.
#
# Two things are easy to forget, and both fail confusingly:
#
#   DSH_HOME  picks which home — and therefore which profile — the harness
#             boots. This repo's scratch home holds the loganz2 pick-list with
#             the bundle linked. Without it the app falls back to ~/.dsh, whose
#             loganz2 profile is an unrelated empty one, so the desktop patch's
#             bridge rows fail to resolve dsh-bundle-loganz2 and the harness
#             exits before the window can connect.
#
#   API keys  reach the provider through the environment. They are read from
#             ~/.dsh/.credentials.yaml here and exported, never printed.
#
# Override either by exporting it before running this script.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DSH_HOME="${DSH_HOME:-$(cd "$here/.." && pwd)/home}"

credentials="${DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
if [ -f "$credentials" ]; then
  while IFS= read -r pair; do
    [ -n "$pair" ] || continue
    export "${pair%%=*}=${pair#*=}"
  done < <(perl -ne 'print "$1=$2\n" while /([A-Z][A-Z0-9_]*)\s*:\s*([^,}[:space:]]+)/g' "$credentials")
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "start.sh: no DEEPSEEK_API_KEY in $credentials" >&2
  echo "start.sh: add it there, or export it before running this script." >&2
  exit 1
fi

echo "start.sh: DSH_HOME=$DSH_HOME"

cd "$here"
exec pnpm start
