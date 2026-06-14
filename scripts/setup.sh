#!/usr/bin/env bash
# Build the bundled Python environment that powers PDF conversion.
# DOCX and HTML import work without this; only PDF needs it.
#
# Uses a self-contained python-build-standalone distribution (not a venv), so the
# environment is fully relocatable and can be bundled into a distributable DMG
# that works on any Mac of the same architecture.
# No pipefail: `curl | grep -m1` legitimately closes the pipe early; the [ -n ]
# guards below catch any genuinely empty result.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYENV="$ROOT/resources/pyenv"
PYVER="3.12"

case "$(uname -m)" in
  arm64)  PBS_ARCH="aarch64-apple-darwin" ;;
  x86_64) PBS_ARCH="x86_64-apple-darwin" ;;
  *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

echo "Resolving latest python-build-standalone release..."
TAG="$(curl -fsSL https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest 2>/dev/null \
  | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
[ -n "$TAG" ] || { echo "Could not resolve release tag" >&2; exit 1; }

URL="$(curl -fsSL "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/$TAG" 2>/dev/null \
  | grep -oE "https://[^\"]*cpython-${PYVER}\.[0-9]+%2B${TAG}-${PBS_ARCH}-install_only\.tar\.gz" | head -1)"
[ -n "$URL" ] || { echo "Could not find a CPython $PYVER asset for $PBS_ARCH in $TAG" >&2; exit 1; }

echo "Downloading $URL"
TMP="$(mktemp -d)"
curl -fsSL "$URL" -o "$TMP/python.tar.gz"
tar -xzf "$TMP/python.tar.gz" -C "$TMP"

rm -rf "$PYENV"
mkdir -p "$PYENV"
cp -R "$TMP/python/." "$PYENV/"
rm -rf "$TMP"

echo "Installing PDF dependencies..."
"$PYENV/bin/python3" -m pip install --quiet --upgrade pip
"$PYENV/bin/python3" -m pip install --quiet -r "$ROOT/requirements.txt"

echo "Pruning unused stdlib to shrink the bundle..."
LIB="$PYENV/lib/python$PYVER"
rm -rf "$LIB/test" "$LIB/idlelib" "$LIB/tkinter" "$LIB/turtledemo" "$LIB/lib2to3" 2>/dev/null || true
find "$PYENV" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "Verifying..."
"$PYENV/bin/python3" -c "import fitz, pymupdf4llm; print('PDF support installed:', fitz.VersionBind)"
echo "Portable Python installed at $PYENV ($(du -sh "$PYENV" | cut -f1))"
