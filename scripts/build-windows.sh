#!/bin/sh
set -e

echo "=========================================================="
echo "  BUILDING WINDOWS STANDALONE PORTABLE EXECUTABLE (.EXE)  "
echo "  Target: Windows x64 (Console + Auto-Browser Launcher)   "
echo "=========================================================="

BUILD_OUT_DIR="/app/build"
mkdir -p "$BUILD_OUT_DIR"

WORKSPACE="/tmp/win-build"
rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"

echo "[1/6] Copying source files and assets..."
cp -r /app/src "$WORKSPACE/"
cp -r /app/config "$WORKSPACE/"
cp -r /app/services "$WORKSPACE/"
cp -r /app/public "$WORKSPACE/"
cp /app/package.json "$WORKSPACE/"
cp /app/.env.example "$WORKSPACE/"

echo "[2/6] Installing production dependencies..."
cd "$WORKSPACE"
npm install --omit=dev --silent

echo "[3/6] Downloading Windows x64 Node.js runtime (v20)..."
curl -sL --retry 3 --connect-timeout 10 -o "$WORKSPACE/node.exe" https://nodejs.org/dist/v20.18.0/win-x64/node.exe

echo "[4/6] Installing Windows x64 SQLite native driver (better_sqlite3.node)..."
mkdir -p "$WORKSPACE/node_modules/better-sqlite3/build/Release"
curl -sL --retry 3 --connect-timeout 10 -H "Accept: application/octet-stream" -o /tmp/bsql.tar.gz https://api.github.com/repos/WiseLibs/better-sqlite3/releases/assets/152884527
tar -zxvf /tmp/bsql.tar.gz -C /tmp/
cp /tmp/build/Release/better_sqlite3.node "$WORKSPACE/node_modules/better-sqlite3/build/Release/"
rm -rf /tmp/bsql.tar.gz /tmp/build

echo "[5/6] Packaging runtime bundle into ZIP payload..."
cd "$WORKSPACE"
7z a -tzip -mx=5 /tmp/payload.zip . >/dev/null

echo "[6/6] Compiling Windows Native PE Launcher with MinGW..."
cp /tmp/payload.zip /app/scripts/windows/payload.zip
cd /app/scripts/windows
x86_64-w64-mingw32-windres app.rc -O coff -o /tmp/app.res
cd /app
x86_64-w64-mingw32-gcc -O3 -s scripts/windows/launcher.c /tmp/app.res -o "$BUILD_OUT_DIR/bot-trading.exe"
rm -f /app/scripts/windows/payload.zip

rm -rf "$WORKSPACE" /tmp/payload.zip /tmp/app.res

echo ""
echo "=========================================================="
echo "  BUILD SUCCESSFUL!                                       "
echo "  Output file: $BUILD_OUT_DIR/bot-trading.exe"
ls -lh "$BUILD_OUT_DIR/bot-trading.exe"
echo "=========================================================="
