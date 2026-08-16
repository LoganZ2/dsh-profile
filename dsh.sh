#!/usr/bin/env bash
# Run dsh against THIS directory's home instead of ~/.dsh.
#
#   ./dsh.sh --dump-config
#   ./dsh.sh "some task"
#
# Everything dsh writes — profiles, sessions, settings, credentials — stays
# under ./home and never touches ~/.dsh.
set -euo pipefail
export DSH_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/home"
exec dsh --profile loganz2 "$@"
