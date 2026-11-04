#!/bin/sh
# Runs the e2e scenarios (`sh e2e/run.sh [scenario ...]`, or `npm run e2e [-- scenario ...]`): builds the Python venv
# with pyte on first use and puts the pinned `pi` from node_modules first on the PATH.
set -eu
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --quiet --disable-pip-version-check -r e2e/requirements.txt
PATH="$PWD/node_modules/.bin:$PATH" exec .venv/bin/python e2e/drive-tui.py "$@"
