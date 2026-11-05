cmake_minimum_required(VERSION 3.24)
project(solus_transcription LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# One pinned runtime, loaded only from its bundled directory.
include(FetchContent)
if(TRANSCRIBE_VULKAN)
  # Older Vulkan SDKs contain headers but not the CMake package ggml requires.
  # CMake's redirect supplies the upstream target without a system install.
  FetchContent_Declare(SPIRV-Headers
    GIT_REPOSITORY https://github.com/KhronosGroup/SPIRV-Headers.git
    GIT_TAG 3f17b2af6784bfa2c5aa5dbb8e0e74a607dd8b3b
    OVERRIDE_FIND_PACKAGE)
endif()
set(TRANSCRIBE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(TRANSCRIBE_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(TRANSCRIBE_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
if(APPLE)
  set(TRANSCRIBE_BUILD_SHARED OFF CACHE BOOL "" FORCE)
else()
  # Optional Vulkan module: a machine without a Vulkan loader can still start
  # the helper and use CPU. Linking Vulkan into the executable would prevent it.
  set(TRANSCRIBE_BUILD_SHARED ON CACHE BOOL "" FORCE)
  set(TRANSCRIBE_GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "AMD64|amd64|x86_64|x64")
    set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
  endif()
  set(CMAKE_INSTALL_RPATH "$ORIGIN")
endif()
set(TRANSCRIBE_USE_SYSTEM_BLAS OFF CACHE BOOL "" FORCE)
set(TRANSCRIBE_X86_CONSERVATIVE ON CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)
set(GGML_VULKAN_SHADER_TYPES "f32,f16,q8_0" CACHE STRING "" FORCE)
set(GGML_VULKAN_MUL_MAT_ID OFF CACHE BOOL "" FORCE)
FetchContent_Declare(transcribe
  GIT_REPOSITORY https://github.com/anomalyco/transcribe.cpp.git
  GIT_TAG 7045d1c0fe7cee37747b2792977421d435e75fca
  GIT_SUBMODULES_RECURSE TRUE)
FetchContent_MakeAvailable(transcribe)
# The pinned upstream uses CMAKE_SOURCE_DIR for this include directory, which
# otherwise points at Solus when consumed as a subproject.
target_include_directories(transcribe PUBLIC "${transcribe_SOURCE_DIR}/include")
add_executable(solus-transcription main.cpp)
target_link_libraries(solus-transcription PRIVATE transcribe)
install(TARGETS solus-transcription RUNTIME DESTINATION . COMPONENT solus-voice)

if(NOT APPLE)
  # ggml registers every CPU ISA variant and optional GPU module here.
  get_target_property(backend_modules ggml MANUALLY_ADDED_DEPENDENCIES)
  foreach(runtime transcribe ggml ggml-base ${backend_modules})
    if(TARGET ${runtime})
      install(TARGETS ${runtime} RUNTIME DESTINATION . COMPONENT solus-voice LIBRARY DESTINATION . COMPONENT solus-voice)
    endif()
  endforeach()
endif()

install(FILES "${transcribe_SOURCE_DIR}/LICENSE" DESTINATION . RENAME LICENSE.transcribe.cpp COMPONENT solus-voice)
install(FILES "${transcribe_SOURCE_DIR}/ggml/LICENSE" DESTINATION . RENAME LICENSE.ggml COMPONENT solus-voice)

if(TRANSCRIBE_VULKAN)
  FetchContent_GetProperties(SPIRV-Headers SOURCE_DIR spirv_headers_source)
  install(FILES "${spirv_headers_source}/LICENSE" DESTINATION . RENAME LICENSE.SPIRV-Headers COMPONENT solus-voice)
endif()
