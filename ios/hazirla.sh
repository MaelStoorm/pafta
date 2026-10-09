#!/bin/bash
# iOS uygulamasının site klasör(ler)ini hazırlar (GitHub Actions'ta derlemeden önce çalışır).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 ios/site.py --html app/src/main/assets/index.html --out ios/gen/Pafta/site --copy app/src/main/assets/ncz.js
