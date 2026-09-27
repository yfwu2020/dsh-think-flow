#!/usr/bin/env bash
# dsh-think-flow 构建脚本
#   ① 探测 DSH 运行时（含 @deepseek-ai/* 包的那层 node_modules）：
#      DSH_CHECKOUT → 本包 node_modules（npm i 装齐 devDependencies）→ dsh CLI 安装层 → npx 缓存
#   ② 建立 node_modules 链接（仅当运行时**不是**本包 node_modules 时）
#   ③ tsc 编译 host 半：src/index.ts → lib/index.js(+ .d.ts)
#   ④ 校验并拷贝 client 半：src/client/index.js → lib/client.js
#        （客户端是手写的 ModuleLoader bundle，无需打包器）
# 用法：bash scripts/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── ① 运行时根：DSH_CHECKOUT → dsh CLI 所在安装 → 常见 checkout → npx 缓存 ──
# 返回「含 @deepseek-ai/dsh-llm 的那层 node_modules」。
probe() {
  local base="${1:-}"
  [ -n "$base" ] || return 1
  if [ -d "$base/@deepseek-ai/dsh-llm" ]; then echo "$base"; return 0; fi
  if [ -d "$base/node_modules/@deepseek-ai/dsh-llm" ]; then echo "$base/node_modules"; return 0; fi
  return 1
}

find_runtime() {
  local found=""
  # 1) 显式指定
  if [ -n "${DSH_CHECKOUT:-}" ]; then
    found="$(probe "$DSH_CHECKOUT" || true)"
    if [ -n "$found" ]; then echo "$found"; return; fi
  fi
  # 2) 本包的 node_modules —— `npm i` 装齐 devDependencies 之后走这条。
  #    公开仓库的默认路径：不要求使用者机器上先有一份 DSH 安装。
  found="$(probe "$ROOT/node_modules" || true)"
  if [ -n "$found" ]; then echo "$found"; return; fi
  # 3) 正在运行的 dsh CLI（PATH 上的 dsh → 真实安装层）
  local cli=""
  cli="$(command -v dsh || true)"
  if [ -n "$cli" ]; then
    local real=""
    real="$(node -e 'const fs=require("fs");try{console.log(fs.realpathSync(process.argv[1]))}catch(e){}' "$cli")"
    if [ -n "$real" ]; then
      # …/node_modules/@deepseek-ai/dsh/lib/bin.js → 逐级向上找
      local dir
      dir="$(dirname "$real")"
      while [ "$dir" != "/" ] && [ -n "$dir" ]; do
        found="$(probe "$dir" || true)"
        if [ -n "$found" ]; then echo "$found"; return; fi
        dir="$(dirname "$dir")"
      done
    fi
  fi
  # 4) 常见 checkout / 缓存
  local candidate
  for candidate in "$HOME/.dsh/dsh-harness" "$HOME/dsh-harness" "$HOME/dsh"; do
    found="$(probe "$candidate" || true)"
    if [ -n "$found" ]; then echo "$found"; return; fi
  done
  for candidate in "$HOME"/.npm/_npx/*/node_modules "$HOME"/.npx/*/node_modules; do
    found="$(probe "$candidate" || true)"
    if [ -n "$found" ]; then echo "$found"; return; fi
  done
  echo ""
}

RUNTIME="$(find_runtime)"
if [ -z "$RUNTIME" ]; then
  echo "build: 找不到 DSH 运行时。两种办法：" >&2
  echo "  · npm i    （装 devDependencies，公开仓库的默认路径）" >&2
  echo "  · DSH_CHECKOUT=/path/to/dsh npm run build   （复用一份已有的 DSH 安装）" >&2
  exit 1
fi
echo "=== DSH 运行时：$RUNTIME ==="

# ── ② 链接 @deepseek-ai / @types（整层 scope 链接，类型与运行时共用） ──
# 运行时就是本包的 node_modules 时**跳过**：`npm i` 已经把 scope 装在那儿了，
# 再去 rmSync + symlink 等于把自己的安装删掉、链成自己（在 Windows 上必炸）。
if [ "$RUNTIME" = "$ROOT/node_modules" ]; then
  echo "=== 用本包 node_modules（devDependencies 已装齐），不另建链接 ==="
else
node -e '
const fs = require("fs")
const path = require("path")
const runtime = process.argv[1]
const root = process.argv[2]
for (const name of ["@deepseek-ai", "@types"]) {
  const target = path.join(runtime, name)
  if (!fs.existsSync(target)) continue
  const link = path.join(root, "node_modules", name)
  fs.rmSync(link, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
  console.log("linked node_modules/" + name + " → " + target)
}
' "$RUNTIME" "$ROOT"
fi

# ── ③ 编译 host 半 ──
TSC="$(command -v tsc || true)"
if [ -z "$TSC" ] && [ -x "$ROOT/node_modules/.bin/tsc" ]; then TSC="$ROOT/node_modules/.bin/tsc"; fi
if [ -z "$TSC" ] && [ -x "$RUNTIME/.bin/tsc" ]; then TSC="$RUNTIME/.bin/tsc"; fi
if [ -z "$TSC" ] && [ -x "$RUNTIME/node_modules/.bin/tsc" ]; then TSC="$RUNTIME/node_modules/.bin/tsc"; fi
# 还有一种：node_modules/@deepseek-ai 是**软链**（build.sh 自己建的，或手工链到某个
# DSH 安装上）。这时 tsc 在链接目标的同级 .bin 里 —— 顺着软链去找。
if [ -z "$TSC" ]; then
  LINKED="$(node -e '
    const fs = require("fs"), path = require("path")
    try {
      const real = fs.realpathSync(path.join(process.argv[1], "@deepseek-ai"))
      console.log(path.join(path.dirname(real), ".bin", "tsc"))
    } catch { console.log("") }
  ' "$RUNTIME")"
  if [ -n "$LINKED" ] && [ -x "$LINKED" ]; then TSC="$LINKED"; fi
fi
if [ -z "$TSC" ]; then
  echo "build: 找不到 tsc。先 npm i（会装上 typescript），或 npm i -g typescript" >&2
  exit 1
fi
echo "=== tsc $("$TSC" -v) ==="
# ⚠️ 必须检查退出码：以前这里是裸调用，类型错误只打印、不中断，
# 于是"=== 构建完成 ==="照打 —— 一条 TS2554 就这样藏了很久。
"$TSC" -p tsconfig.json || { echo "build: host 类型检查没过，中止" >&2; exit 1; }

# ── ④ client 半 ──
echo "=== client bundle：src/client/index.js → lib/client.js ==="
node --check src/client/index.js
mkdir -p lib
cp src/client/index.js lib/client.js

echo "=== 构建完成 ==="
ls -l lib
