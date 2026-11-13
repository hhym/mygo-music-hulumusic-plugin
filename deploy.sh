#!/bin/bash
# 部署插件到 MyGo 安装目录（每次改完必须跑）
# 用法:
#   ./deploy.sh                 # 自动探测 Windows 的 MyGo 插件目录
#   ./deploy.sh /path/to/dir    # 指定目标目录
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"

# 目标目录：优先命令行参数，其次环境变量，最后按平台自动探测
DST="${1:-${MYGO_PLUGIN_DIR:-}}"
if [ -z "$DST" ]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      # Windows: %APPDATA%/MyGo Music/plugins/<插件名>
      DST="${APPDATA:-$HOME/AppData/Roaming}/MyGo Music/plugins/hulu-music"
      ;;
    Darwin)
      DST="$HOME/Library/Application Support/MyGo Music/plugins/hulu-music"
      ;;
    *)
      DST="${XDG_CONFIG_HOME:-$HOME/.config}/MyGo Music/plugins/hulu-music"
      ;;
  esac
fi

if [ ! -d "$DST" ]; then
  echo "✗ 目标目录不存在: $DST"
  echo "  请先启动一次 MyGo 让它创建插件目录，或用 ./deploy.sh <目录> 指定"
  exit 1
fi

cp "$SRC/index.js"    "$DST/index.js"
cp "$SRC/plugin.json" "$DST/plugin.json"
# locales / bin 只在首次缺的时候补，不覆盖（体积大、很少改）
[ -d "$DST/locales" ] || cp -r "$SRC/locales" "$DST/locales" 2>/dev/null || true
[ -d "$DST/bin" ]     || cp -r "$SRC/bin"     "$DST/bin"     2>/dev/null || true

echo "✓ 已部署到 $DST"
grep -m1 '"version"' "$DST/plugin.json"
echo "⚠️  MyGo 只在启动时读插件，改完要重启 MyGo 才生效"
