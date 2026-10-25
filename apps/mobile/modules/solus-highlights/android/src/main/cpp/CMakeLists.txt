# Adapted from T3 Code apps/mobile/modules/t3-highlights/android/src/main/cpp/CMakeLists.txt (MIT, see apps/mobile/UPSTREAM.md).
cmake_minimum_required(VERSION 3.22.1)

project(solushighlights LANGUAGES C)

set(SOLUS_HIGHLIGHTS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../..")

add_library(
  solushighlights SHARED
  solus_highlights_jni.c
  "${SOLUS_HIGHLIGHTS_ROOT}/cpp/solus_highlights.c"
  "${SOLUS_HIGHLIGHTS_ROOT}/Vendor/highlights/highlights.c"
  "${SOLUS_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-impl.c"
  "${SOLUS_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-mem-impl.c"
)

target_include_directories(
  solushighlights
  PRIVATE "${SOLUS_HIGHLIGHTS_ROOT}/cpp" "${SOLUS_HIGHLIGHTS_ROOT}/Vendor"
          "${SOLUS_HIGHLIGHTS_ROOT}/Vendor/highlights" "${SOLUS_HIGHLIGHTS_ROOT}/Vendor/wasm2c"
)

# Plain malloc memory with explicit bounds checks: no guard-page signal
# handlers competing with ART's.
target_compile_definitions(
  solushighlights PRIVATE WASM_RT_USE_MMAP=0 WASM_RT_MEMCHECK_BOUNDS_CHECK=1
                          WASM_RT_SKIP_SIGNAL_RECOVERY=1
)

# The lexers are generated code; keep them fast in debug builds too.
target_compile_options(solushighlights PRIVATE -O2)

# Android 15 devices can use 16 KB memory pages.
target_link_options(
  solushighlights PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)
