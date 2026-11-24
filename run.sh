#!/usr/bin/env bash
# ArkaGrid launcher for macOS / Linux:  chmod +x run.sh && ./run.sh
set -e
cd "$(dirname "$0")"

command -v python3 >/dev/null || { echo "Python 3 is required."; exit 1; }
command -v npm >/dev/null     || { echo "Node.js (npm) is required for the 3D twin."; exit 1; }

[ -d node_modules/three ] || { echo "Installing three.js..."; npm install --silent; }

if [ ! -d .venv ]; then python3 -m venv .venv 2>/dev/null || true; fi
[ -f .venv/bin/activate ] && source .venv/bin/activate
pip install -q -r requirements.txt

python engine_a/anomaly_detection.py --serve --open "$@"
