#!/bin/bash
# Mac：在 Finder 雙擊即可（第一次若被擋，右鍵 →「打開」）
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  echo "需要 Node.js 22：https://nodejs.org"
  open https://nodejs.org
  read -r -p "按 Enter 關閉"
  exit 1
fi
command -v git >/dev/null && git pull
npm install --no-audit --no-fund || { read -r -p "安裝失敗，按 Enter 關閉"; exit 1; }
node tools/playtest.mjs
