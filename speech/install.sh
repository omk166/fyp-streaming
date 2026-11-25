#!/bin/sh
# Installs the local speech service (Omnilingual ASR) into .venv-omniasr. Run once per computer: npm run speech:install
# omnilingual-asr 0.2.0 declares Python ">=3.10,<=3.12", which pip reads as excluding 3.12.1+, so 3.10/3.11 are used.
set -e
cd "$(dirname "$0")/.."
PYTHON=${PYTHON:-$(command -v python3.11 || command -v python3.10 || true)}
if [ -z "$PYTHON" ]; then
  echo 'Python 3.11 (or 3.10) is required for Omnilingual ASR. macOS: brew install python@3.11; set PYTHON=/path/to/python3.11 if it is elsewhere.' >&2
  exit 1
fi
"$PYTHON" -m venv .venv-omniasr
.venv-omniasr/bin/python -m pip install -r speech/requirements.txt
echo 'Installed. Start the service with: npm run speech   (the first start downloads the model, about 8.5 GiB)'
