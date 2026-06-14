#!/usr/bin/env bash
# Build the bundled Python environment that powers PDF conversion.
# DOCX and HTML import work without this; only PDF needs it.
#
# PyMuPDF 1.27+ ships abi3 wheels that cover CPython 3.10 through 3.14.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/resources/pyenv"

pick_python() {
  for c in python3.12 python3.11 python3.13 python3.14 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1; then echo "$c"; return; fi
  done
  echo ""; return
}

PY="$(pick_python)"
if [ -z "$PY" ]; then
  echo "No python3 found. Install Python 3.10+ (e.g. 'brew install python@3.12')." >&2
  exit 1
fi

VER="$("$PY" -c 'import sys; print("%d.%d"%sys.version_info[:2])')"
echo "Using $PY (Python $VER)"

rm -rf "$VENV"
"$PY" -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip >/dev/null
"$VENV/bin/pip" install -r "$ROOT/requirements.txt"

echo
echo "Verifying..."
"$VENV/bin/python3" -c "import fitz, pymupdf4llm; print('PyMuPDF', fitz.__doc__.split()[1] if fitz.__doc__ else '?', 'ok')"
echo "PDF support installed at $VENV"
