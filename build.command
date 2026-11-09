#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Building AlgoSteer…"
echo "Requires Node.js 22+ and internet access the first time."
npm ci
npm test
npm run build
printf '\nFinished. Open chrome://extensions, enable Developer mode, and Load unpacked -> %s/dist\n' "$PWD"
read -r -p "Press Enter to close this window."
