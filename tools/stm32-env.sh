#!/bin/sh

# Source this file from the repository root before using the STM32 command-line
# tools, for example: . tools/stm32-env.sh

_stm32_bundle_root="${CUBE_BUNDLE_PATH:-/Users/andrewdutka/Library/Application Support/stm32cube/bundles}"
_stm32_pack_root="${CMSIS_PACK_ROOT:-/Users/andrewdutka/Library/Application Support/stm32cube/packs}"

_stm32_bundle_bin() {
    _stm32_bundle_name="$1"
    _stm32_bundle_dir=""

    if [ -d "$_stm32_bundle_root/$_stm32_bundle_name" ]; then
        _stm32_bundle_dir="$(find "$_stm32_bundle_root/$_stm32_bundle_name" -mindepth 1 -maxdepth 1 -type d -print | sort | tail -n 1)"
    fi

    if [ -z "$_stm32_bundle_dir" ] || [ ! -d "$_stm32_bundle_dir/bin" ]; then
        echo "STM32 bundle not found: $_stm32_bundle_name" >&2
        echo "Install it with the STM32Cube VS Code bundle manager, then source this file again." >&2
        return 1
    fi

    printf '%s/bin\n' "$_stm32_bundle_dir"
}

_stm32_starm_bin="$(_stm32_bundle_bin st-arm-clang)" || return 1
_stm32_gdb_bin="$(_stm32_bundle_bin gnu-gdb-for-stm32)" || return 1
_stm32_stlink_bin="$(_stm32_bundle_bin stlink-gdbserver)" || return 1
_stm32_programmer_bin="$(_stm32_bundle_bin programmer)" || return 1

export CUBE_BUNDLE_PATH="$_stm32_bundle_root"
export CMSIS_PACK_ROOT="$_stm32_pack_root"
export PATH="$_stm32_starm_bin:$_stm32_gdb_bin:$_stm32_stlink_bin:$_stm32_programmer_bin:$PATH"

unset _stm32_bundle_root _stm32_pack_root _stm32_bundle_name _stm32_bundle_dir
unset _stm32_starm_bin _stm32_gdb_bin _stm32_stlink_bin _stm32_programmer_bin
