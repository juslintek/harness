#!/bin/sh
set -eu

REPO="${HARNESS_REPO:-juslintek/harness}"
VERSION="${HARNESS_VERSION:-latest}"
BACKEND="${HARNESS_BACKEND:-ts}"
INSTALL_DIR="${HARNESS_INSTALL_DIR:-$HOME/.local/bin}"
CUSTOM_SHARE_DIR="${HARNESS_SHARE_DIR:-}"

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
case "$BACKEND" in
  ts) asset="harness-${target}.tar.gz" ;;
  zig) asset="harness-zig-${target}.tar.gz" ;;
  *)
    echo "Unsupported HARNESS_BACKEND: $BACKEND (expected ts or zig)" >&2
    exit 1
    ;;
esac

if [ -n "${HARNESS_BASE_URL:-}" ]; then
  base_url="${HARNESS_BASE_URL%/}"
elif [ "$VERSION" = "latest" ]; then
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
INSTALL_DIR=$(CDPATH='' cd -- "$INSTALL_DIR" && pwd)
parent_dir=$(dirname "$INSTALL_DIR")
if [ "$parent_dir" = "/" ]; then
  DEFAULT_SHARE_DIR="/share/harness"
else
  DEFAULT_SHARE_DIR="${parent_dir}/share/harness"
fi
if [ -n "$CUSTOM_SHARE_DIR" ]; then
  mkdir -p "$CUSTOM_SHARE_DIR"
  SHARE_DIR=$(CDPATH='' cd -- "$CUSTOM_SHARE_DIR" && pwd)
else
  SHARE_DIR="$DEFAULT_SHARE_DIR"
fi

tar -xzf "${tmp_dir}/${asset}" -C "$tmp_dir"
install -m 0755 "${tmp_dir}/harness" "${INSTALL_DIR}/harness"
if [ -f "${tmp_dir}/harness-hook" ]; then
  install -m 0755 "${tmp_dir}/harness-hook" "${INSTALL_DIR}/harness-hook"
fi

for dir in ui adapters vendor; do
  if [ -d "${tmp_dir}/${dir}" ]; then
    mkdir -p "$SHARE_DIR"
    rm -rf "${SHARE_DIR:?}/${dir}"
    cp -R "${tmp_dir}/${dir}" "${SHARE_DIR}/${dir}"
  fi
done

echo "Installed harness (${BACKEND}) to ${INSTALL_DIR}"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to your PATH: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
if [ "$SHARE_DIR" != "$DEFAULT_SHARE_DIR" ] && [ -d "${SHARE_DIR}/ui" ]; then
  if [ "$BACKEND" = "zig" ]; then
    echo "Run 'HARNESS_UI_DIST=\"${SHARE_DIR}/ui\" harness serve' to start."
  else
    echo "Run 'HARNESS_SHARE_DIR=\"${SHARE_DIR}\" harness serve' to start."
  fi
else
  echo "Run 'harness serve' to start."
fi
