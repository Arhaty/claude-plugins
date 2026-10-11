#!/usr/bin/env bash
# Download a pinned release binary, verify its SHA-256, and put it on PATH.
#
#   .github/scripts/install-tool.sh <actionlint|zizmor|typos|lychee> [bin-dir]
#
# The workflows run these tools as binaries rather than through third-party actions, so the only
# code that runs is a release artefact whose checksum is pinned here. Supported platforms: Linux
# x86_64 (CI) and macOS arm64 (local). To upgrade a tool, change its version and both checksums;
# GitHub shows each asset's digest on the release page.
set -euo pipefail

tool="${1:?usage: install-tool.sh <tool> [bin-dir]}"
bin="${2:-${RUNNER_TEMP:-/tmp}/canon-tools/bin}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux ;;
  Darwin-arm64) platform=mac ;;
  *) echo "install-tool: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

case "$tool-$platform" in
  actionlint-linux)
    url=https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz
    sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  actionlint-mac)
    url=https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_darwin_arm64.tar.gz
    sha=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  zizmor-linux)
    url=https://github.com/zizmorcore/zizmor/releases/download/v1.30.1/zizmor-x86_64-unknown-linux-gnu.tar.gz
    sha=e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a ;;
  zizmor-mac)
    url=https://github.com/zizmorcore/zizmor/releases/download/v1.30.1/zizmor-aarch64-apple-darwin.tar.gz
    sha=e28d22b087f9ebb8d99da6e740d348c930f559961c7c3f12badda54f882195a2 ;;
  typos-linux)
    url=https://github.com/crate-ci/typos/releases/download/v1.51.1/typos-v1.51.1-x86_64-unknown-linux-musl.tar.gz
    sha=93c301fd4120ff076e2cc2a6d6a61cab4a4bdb81899287c0938b452e56d1f454 ;;
  typos-mac)
    url=https://github.com/crate-ci/typos/releases/download/v1.51.1/typos-v1.51.1-aarch64-apple-darwin.tar.gz
    sha=316d50a32c3726a80ab39c6d12141b70080498973c5e8a9b068b12cde78b10c1 ;;
  lychee-linux)
    url=https://github.com/lycheeverse/lychee/releases/download/lychee-v0.24.2/lychee-x86_64-unknown-linux-gnu.tar.gz
    sha=1f4e0ef7f6554a6ed33dd7ac144fb2e1bbed98598e7af973042fc5cd43951c9a ;;
  lychee-mac)
    url=https://github.com/lycheeverse/lychee/releases/download/lychee-v0.24.2/lychee-aarch64-apple-darwin.tar.gz
    sha=c9d3740ea2d891854d37116c9fba840f37b6e7c89d330e7db84ac333631c4977 ;;
  *) echo "install-tool: unknown tool $tool" >&2; exit 1 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl --fail --silent --show-error --location --retry 3 --output "$work/archive.tar.gz" "$url"

if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$work/archive.tar.gz" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$work/archive.tar.gz" | cut -d' ' -f1)"
fi
if [ "$actual" != "$sha" ]; then
  echo "install-tool: checksum mismatch for $tool: expected $sha, got $actual" >&2
  exit 1
fi

tar -xzf "$work/archive.tar.gz" -C "$work"
found="$(find "$work" -type f -name "$tool" | head -n 1)"
[ -n "$found" ] || { echo "install-tool: $tool not found in the archive" >&2; exit 1; }
mkdir -p "$bin"
install -m 0755 "$found" "$bin/$tool"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$bin" >> "$GITHUB_PATH"; fi
echo "$bin/$tool"
