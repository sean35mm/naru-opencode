#!/bin/sh
# Naru bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/sean35mm/naru-opencode/main/bootstrap.sh | sh
#
# Downloads the latest Naru release into ~/.naru and installs the `naru` command.
# It does NOT touch your OpenCode configuration: run `naru install` afterwards,
# which previews every change and asks before applying it.
set -eu

REPO=${NARU_REPO:-sean35mm/naru-opencode}
NARU_HOME=${NARU_HOME:-"${HOME}/.naru"}
API=${NARU_API:-"https://api.github.com/repos/${REPO}"}
MODIFY_PATH=false
REQUESTED_VERSION=""

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [--version TAG] [--modify-path]

  --version TAG   Install an exact release tag (default: latest)
  --modify-path   Append the PATH line to your shell profile
                  (default: print it and let you decide)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --modify-path) MODIFY_PATH=true ;;
    --version)
      [ $# -ge 2 ] || { echo "bootstrap: --version requires a value" >&2; exit 2; }
      REQUESTED_VERSION=$2
      shift
      ;;
    --help|-h) usage; exit 0 ;;
    *) echo "bootstrap: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "bootstrap: required command not found: $1" >&2
    exit 1
  }
}
need curl
need tar
need node

# Naru's installer runs on Node. Fail early rather than half-installing.
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 20 ]; then
  echo "bootstrap: Node 20 or newer is required (found $(node -v 2>/dev/null || echo none))" >&2
  exit 1
fi

checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    echo "bootstrap: need shasum or sha256sum to verify the download" >&2
    exit 1
  fi
}

if [ -n "$REQUESTED_VERSION" ]; then
  VERSION=$REQUESTED_VERSION
else
  VERSION=$(curl -fsSL "${API}/releases/latest" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).tag_name;if(typeof t==="string"&&t)process.stdout.write(t)}catch{}})') || true
  [ -n "$VERSION" ] || {
    echo "bootstrap: could not determine the latest release of ${REPO}." >&2
    echo "bootstrap: if no release exists yet, clone the repo and run ./install.sh instead." >&2
    exit 1
  }
fi

# Tag v0.2.0 -> directory 0.2.0.
PLAIN=${VERSION#v}
TARBALL="naru-${PLAIN}.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${VERSION}"
TARGET="${NARU_HOME}/versions/${PLAIN}"

echo "Naru ${VERSION}"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/naru-bootstrap.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "  downloading ${TARBALL}"
curl -fsSL "${BASE}/${TARBALL}" -o "${TMP}/${TARBALL}"
curl -fsSL "${BASE}/${TARBALL}.sha256" -o "${TMP}/${TARBALL}.sha256"

expected=$(cut -d' ' -f1 < "${TMP}/${TARBALL}.sha256")
actual=$(checksum "${TMP}/${TARBALL}")
if [ "$expected" != "$actual" ]; then
  echo "bootstrap: checksum mismatch; refusing to install" >&2
  echo "  expected ${expected}" >&2
  echo "  actual   ${actual}" >&2
  exit 1
fi
echo "  checksum verified"

mkdir -p "${TMP}/x"
tar -xzf "${TMP}/${TARBALL}" -C "${TMP}/x"
# Release tarballs contain a single top-level directory.
root=$(find "${TMP}/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$root" ] || { echo "bootstrap: unexpected tarball layout" >&2; exit 1; }
[ -f "${root}/install.sh" ] || { echo "bootstrap: tarball is missing install.sh" >&2; exit 1; }

mkdir -p "${NARU_HOME}/versions" "${NARU_HOME}/bin"
rm -rf "$TARGET"
mv "$root" "$TARGET"
ln -sfn "$TARGET" "${NARU_HOME}/current"

# The shim is intentionally trivial so `naru upgrade` only has to move `current`.
cat > "${NARU_HOME}/bin/naru" <<EOF
#!/bin/sh
exec "\${NARU_HOME:-\${HOME}/.naru}/current/bin/naru" "\$@"
EOF
chmod 755 "${NARU_HOME}/bin/naru"
chmod 755 "${TARGET}/bin/naru" 2>/dev/null || true

echo "  installed to ${TARGET}"

case ":${PATH}:" in
  *":${NARU_HOME}/bin:"*) ON_PATH=true ;;
  *) ON_PATH=false ;;
esac

PATH_LINE="export PATH=\"${NARU_HOME}/bin:\$PATH\""

if [ "$ON_PATH" = true ]; then
  :
elif [ "$MODIFY_PATH" = true ]; then
  case "${SHELL:-}" in
    */zsh) profile="${HOME}/.zshrc" ;;
    */bash) profile="${HOME}/.bashrc" ;;
    *) profile="${HOME}/.profile" ;;
  esac
  if [ -f "$profile" ] && grep -qF "${NARU_HOME}/bin" "$profile"; then
    echo "  PATH already configured in ${profile}"
  else
    printf '\n# Naru\n%s\n' "$PATH_LINE" >> "$profile"
    echo "  added Naru to PATH in ${profile}"
    echo "  run: . ${profile}"
  fi
fi

echo
echo "Done. Naru is downloaded but not yet installed into OpenCode."
if [ "$ON_PATH" = false ] && [ "$MODIFY_PATH" = false ]; then
  echo
  echo "Add this to your shell profile (or rerun with --modify-path):"
  echo "  ${PATH_LINE}"
  echo
  echo "Then run:"
  echo "  naru install"
else
  echo
  echo "Next:"
  echo "  naru install     # previews every change and asks before applying"
fi
