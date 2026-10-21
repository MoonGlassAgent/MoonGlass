#!/usr/bin/env bash
# 重建 cocotb 的 Verilator VPI 支持库（Windows 专用自救脚本）
#
# 背景：上游 cocotb 对 Verilator 后端的 VPI 库只在 posix 构建（cocotb_build_libs.py
# 的 os.name == "posix" 守卫），Windows wheel 不含 cocotbvpi_verilator 任何产物
# ——于是 cocotb+verilator 仿真"编译过（孤儿导入库在）、运行炸（0xC0000135 缺 DLL）"。
#
# 本脚本的口径：用 MinGW g++（与 oss-cad-suite 仿真链路同编译器家族，无 ABI 问题）
# 把 cocotb 的 VPI 栈（vpi/gpi/gpi_log/utils/embed）静态编译为
# libcocotbvpi_verilator.a 并安装到 cocotb 的 libs/ ——仿真 exe 链接时静态包含，
# 不产生 DLL 依赖，也就不需要 PE 的 exe 符号导出体操。
#
# 用法（Git Bash）：bash scripts/build-cocotb-vpi-static.sh
# 幂等：可重复运行；cocotb 重装/升级后需要重跑（site-packages 被重置）。
set -euo pipefail

COCOTB_DIR=$(python -c "import cocotb, os; print(os.path.dirname(cocotb.__file__))")
COCOTB_VER=$(python -c "import cocotb; print(cocotb.__version__)")
echo "[vpi-static] cocotb $COCOTB_VER @ $COCOTB_DIR"

# 取与已装版本一致的源码（wheel 不含 share/lib 的 C++ 源，必须 sdist）
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
pip download "cocotb==$COCOTB_VER" --no-deps --no-binary :all: -d "$WORK" -q
tar -xzf "$WORK"/cocotb-*.tar.gz -C "$WORK"
SD=$(echo "$WORK"/cocotb-*/src/cocotb)

# MinGW g++：优先 oss-cad-suite 自带，回落 Strawberry，再回落 PATH
CXX=""
for c in ${OSS_CAD_SUITE:+"$OSS_CAD_SUITE/bin/g++.exe"} /c/Strawberry/c/bin/g++.exe; do
  [ -x "$c" ] && CXX="$c" && break
done
[ -z "$CXX" ] && CXX=$(command -v g++ || true)
[ -z "$CXX" ] && { echo "找不到 MinGW g++（oss-cad-suite/Strawberry/PATH 均无）"; exit 1; }
echo "[vpi-static] g++ = $CXX"

PY_INC=$(python -c "import sysconfig;print(sysconfig.get_paths()['include'])")
OUT="$WORK/out"; mkdir -p "$OUT"

# 口径说明：
# - 各 *_EXPORTS 让头文件走 dllexport 口径（静态链路里只是声明一致化）
# - -UWIN32：vendored vpi_user.h 以 WIN32 宏决定 PLI_DLLESPEC=dllexport，
#   静态链路要纯符号（无 __imp_ 间接），故摘掉（_WIN32 保留，平台代码不受影响）
# - PYTHON_LIB / EMBED_IMPL_LIB：embed.cpp 动态加载 python 与 cocotb.dll 的名字
SRCS="
$SD/share/lib/vpi/VpiImpl.cpp
$SD/share/lib/vpi/VpiCbHdl.cpp
$SD/share/lib/vpi/VpiObj.cpp
$SD/share/lib/vpi/VpiIterator.cpp
$SD/share/lib/vpi/VpiSignal.cpp
$SD/share/lib/gpi/GpiCommon.cpp
$SD/share/lib/gpi/GpiCbHdl.cpp
$SD/share/lib/gpi_log/gpi_logging.cpp
$SD/share/lib/utils/cocotb_utils.cpp
$SD/share/lib/embed/gpi_embed.cpp
$SD/share/lib/embed/embed.cpp
"
for f in $SRCS; do
  o="$OUT/$(basename "$f" .cpp).o"
  echo "[build] $(basename "$f")"
  "$CXX" -std=c++17 -O2 \
    -D__STDC_FORMAT_MACROS -DVERILATOR \
    -DCOCOTBVPI_EXPORTS -DGPI_EXPORTS -DGPILOG_EXPORTS -DCOCOTBUTILS_EXPORTS -DEMBED_EXPORTS \
    -DPYTHON_LIB=python313.dll -DEMBED_IMPL_LIB=cocotb.dll \
    -UWIN32 -UWIN64 \
    -I "$SD/share/include" -I "$SD" -I "$PY_INC" \
    -c "$f" -o "$o"
done
ar rcs "$OUT/libcocotbvpi_verilator.a" "$OUT"/*.o

# 安装到 cocotb libs/；陈旧孤儿导入库（.dll.a）若存在须让位（ld 优先命中它会回到 DLL 依赖）
LIBS_DIR="$COCOTB_DIR/libs"
[ -f "$LIBS_DIR/libcocotbvpi_verilator.dll.a" ] && mv "$LIBS_DIR/libcocotbvpi_verilator.dll.a" "$LIBS_DIR/libcocotbvpi_verilator.dll.a.bak"
cp "$OUT/libcocotbvpi_verilator.a" "$LIBS_DIR/libcocotbvpi_verilator.a"
echo "[vpi-static] 已安装 $LIBS_DIR/libcocotbvpi_verilator.a"
echo "[vpi-static] 验证：node scripts/waveform-guard-smoke.mjs（cocotb 段应全绿）"
