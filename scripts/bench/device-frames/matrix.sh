#!/usr/bin/env bash
# Usage: matrix.sh <variant>. Runs every scenario once for one code variant.
cd "$(dirname "$0")"
./run.sh "$1/local" 0 0
./run.sh "$1/local-busy-renderer" 0 60
./run.sh "$1/remote-20mbps" 20 0
./run.sh "$1/remote-6mbps" 6 0
