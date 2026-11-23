#!/bin/sh
set -eu

REPO="${HARNESS_REPO:-juslintek/harness}"
VERSION="${HARNESS_VERSION:-latest}"
INSTALL_DIR="${HARNESS_INSTALL_DIR:-$HOME/.local/bin}"
SHARE_DIR="${HARNESS_SHARE_DIR:-$(dirname "$INSTALL_DIR")/share/harness}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)

case "$os" in
  linux) os="linux" ;;
  darwin) os="darwin" ;;
  *)
    echo "Unsupported OS: $os" >&2
    exit 1
    ;;
esac

case "$arch" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

target="${os}-${arch}"
asset="harness-zig-${target}.tar.gz"

if [ "$VERSION" = "latest" ]; then
  base_url="https://github.com/${REPO}/releases/latest/download"
else
  base_url="https://github.com/${REPO}/releases/download/${VERSION}"
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "Need curl or wget to download Harness." >&2
    exit 1
  fi
}

echo "Downloading ${asset} (${VERSION})..."
download "${base_url}/${asset}" "${tmp_dir}/${asset}"
download "${base_url}/${asset}.sha256" "${tmp_dir}/${asset}.sha256"

echo "Verifying checksum..."
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp_dir" && sha256sum -c "${asset}.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$tmp_dir" && shasum -a 256 -c "${asset}.sha256")
else
  echo "Error: sha256sum/shasum not found, cannot verify checksum. Aborting." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "${tmp_dir}/${asset}" -C "$tmp_dir"
install -m 0755 "${tmp_dir}/harness" "${INSTALL_DIR}/harness"
install -m 0755 "${tmp_dir}/harness-hook" "${INSTALL_DIR}/harness-hook"

if [ -d "${tmp_dir}/ui" ]; then
  mkdir -p "$SHARE_DIR"
  rm -rf "${SHARE_DIR}/ui"
  cp -R "${tmp_dir}/ui" "${SHARE_DIR}/ui"
fi

echo "Installed harness and harness-hook to ${INSTALL_DIR}"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to your PATH: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
echo "Run 'harness serve' to start."
