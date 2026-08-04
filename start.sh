#!/bin/bash
# Mac / Linux 启动器：双击或在终端运行
cd "$(dirname "$0")"
export MAILER_DATA_DIR="$(dirname "$0")/data"
mkdir -p "$MAILER_DATA_DIR"
open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null
exec node "$(dirname "$0")/server.js"
