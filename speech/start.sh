#!/bin/sh
# Starts the local speech service on http://127.0.0.1:8765: npm run speech [-- --allow-origin https://your-meeting-site]
set -e
cd "$(dirname "$0")/.."
if [ ! -x .venv-omniasr/bin/python ]; then
  echo 'The speech service is not installed on this computer yet: run npm run speech:install first.' >&2
  exit 1
fi
cd speech
exec ../.venv-omniasr/bin/python -u service.py "$@"
