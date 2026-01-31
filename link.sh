#!/usr/bin/env bash
# Link packages with binaries for local development

set -e

cd "$(dirname "$0")"

echo "Linking packages..."

# coding-agent has the 'omp' binary
(cd packages/coding-agent && bun link)

echo ""
echo "Done! 'omp' is now available globally."
