#!/usr/bin/env bash
# bootstrap.sh — one-line installer prep for ORCA customers.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/orcahqlimited/orca-deploy/main/bootstrap.sh | bash
#
# What it does, in order:
#   1. Checks you are on WSL/Ubuntu, Linux, or macOS (native Windows refused).
#   2. Installs the CLI tools the real installer needs: az, node 20, kubectl, helm.
#   3. Downloads the latest ORCA installer release from GitHub.
#   4. Extracts the tarball and runs `npm install` inside it.
#   5. Prints the three remaining commands to complete the deploy.
#
# Safe to re-run. Every tool-install step checks for existing presence first.
# Failures surface an actionable message and the install-guide URL.

set -euo pipefail

ORCA_DIR="${HOME}/orca-install"
REPO="orcahqlimited/orca-deploy"
RELEASES_API="https://api.github.com/repos/${REPO}/releases/latest"
INSTALL_GUIDE_URL="https://orcahq.ai/install"

# ── formatting helpers ───────────────────────────────────────────────
C_OK='\033[32m'
C_WARN='\033[33m'
C_ERR='\033[31m'
C_DIM='\033[90m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

ok()    { printf "${C_OK}✓${C_RESET} %s\n" "$*"; }
info()  { printf "${C_DIM}▸${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_WARN}!${C_RESET} %s\n" "$*"; }
fail()  { printf "${C_ERR}✗${C_RESET} %s\n" "$*" >&2; }

abort() {
  fail "$1"
  echo
  fail "Stopping. Full step-by-step guide: ${INSTALL_GUIDE_URL}"
  exit 1
}

# ── banner ───────────────────────────────────────────────────────────
printf "\n${C_BOLD}═══ ORCA installer bootstrap ═══${C_RESET}\n\n"

# ── 1. platform detection ────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux*)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      PLATFORM="wsl"
      ok "Platform: WSL Ubuntu"
    else
      PLATFORM="linux"
      ok "Platform: Linux"
    fi
    ;;
  Darwin*)
    PLATFORM="macos"
    ok "Platform: macOS"
    ;;
  MINGW*|CYGWIN*|MSYS*)
    abort "Native Windows shell detected. ORCA must be installed from inside WSL, not Git Bash / Cygwin / PowerShell. See ${INSTALL_GUIDE_URL} Part 1.3 for a 5-minute WSL setup."
    ;;
  *)
    abort "Unsupported platform: $OS. ORCA supports WSL (on Windows), macOS, and Linux."
    ;;
esac

# ── 2. az CLI ────────────────────────────────────────────────────────
if command -v az >/dev/null 2>&1; then
  ok "Azure CLI present ($(az version --query '\"azure-cli\"' -o tsv 2>/dev/null || echo unknown))"
else
  info "Installing Azure CLI (may ask for your sudo password)..."
  if [ "$PLATFORM" = "macos" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      abort "Homebrew is required on macOS. Install from https://brew.sh then re-run this script."
    fi
    brew install azure-cli
  else
    # WSL / Linux — Microsoft's Debian/Ubuntu installer
    curl -fsSL https://aka.ms/InstallAzureCLIDeb -o /tmp/az-install.sh
    sudo bash /tmp/az-install.sh
    rm -f /tmp/az-install.sh
  fi
  ok "Azure CLI installed"
fi

# ── 3. Node.js 20 ────────────────────────────────────────────────────
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "node $(node --version) present"
    NEED_NODE=0
  else
    warn "node $(node --version 2>/dev/null || echo 'unknown') present but need v20+ — upgrading"
  fi
fi

if [ "$NEED_NODE" = "1" ]; then
  info "Installing Node.js 20..."
  if [ "$PLATFORM" = "macos" ]; then
    brew install node@20
    brew link --force --overwrite node@20
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource.sh
    sudo -E bash /tmp/nodesource.sh
    sudo apt install -y nodejs
    rm -f /tmp/nodesource.sh
  fi
  ok "Node $(node --version) installed"
fi

# ── 4. kubectl ───────────────────────────────────────────────────────
if command -v kubectl >/dev/null 2>&1; then
  ok "kubectl present"
else
  info "Installing kubectl..."
  if [ "$PLATFORM" = "macos" ]; then
    brew install kubectl
  else
    # Prefer az-bundled kubectl (version-matched to AKS defaults)
    if ! sudo az aks install-cli >/dev/null 2>&1; then
      # Fallback: direct binary download
      KUBE_V="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
      sudo curl -fsSL "https://dl.k8s.io/release/${KUBE_V}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl
      sudo chmod +x /usr/local/bin/kubectl
    fi
  fi
  ok "kubectl installed"
fi

# ── 5. helm ──────────────────────────────────────────────────────────
if command -v helm >/dev/null 2>&1; then
  ok "helm $(helm version --short 2>/dev/null || echo present)"
else
  info "Installing helm..."
  if [ "$PLATFORM" = "macos" ]; then
    brew install helm
  else
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 -o /tmp/get-helm.sh
    bash /tmp/get-helm.sh
    rm -f /tmp/get-helm.sh
  fi
  ok "helm installed"
fi

# ── 6. working directory ─────────────────────────────────────────────
mkdir -p "$ORCA_DIR"
cd "$ORCA_DIR"
ok "Working directory: $ORCA_DIR"

# ── 7. fetch latest release ──────────────────────────────────────────
info "Looking up latest ORCA installer release..."
TAG="$(curl -fsSL "$RELEASES_API" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null || true)"

if [ -z "$TAG" ]; then
  abort "Could not read latest release metadata from ${RELEASES_API}. Check internet + DNS, then re-run. For manual download steps, see ${INSTALL_GUIDE_URL} Part 2.2."
fi
ok "Latest release: ${TAG}"

VERSION="${TAG#v}"
TARBALL="orcahq-deploy-${VERSION}.tgz"
ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/${TARBALL}"

info "Downloading ${TARBALL}..."
if ! curl -fsSL "$ASSET_URL" -o "$TARBALL"; then
  abort "Failed to download ${ASSET_URL}. Retry, or use the manual GitHub CLI path in ${INSTALL_GUIDE_URL} Part 2.2."
fi
ok "Tarball downloaded ($(du -h "$TARBALL" | cut -f1))"

# ── 8. extract + npm install ─────────────────────────────────────────
info "Extracting..."
tar -xzf "$TARBALL"
cd package

info "Installing installer dependencies (~1 min)..."
# --silent keeps stdout quiet but npm still prints warnings to stderr, which we'd rather keep
npm install --production --silent 2>&1 | tail -3
ok "Installer ready"

# ── 9. next-step banner ──────────────────────────────────────────────
cat <<EOF

${C_BOLD}═══ Bootstrap complete ═══${C_RESET}

Your workstation is ready. Two remaining steps to deploy ORCA:

  ${C_BOLD}1) Launch the installer${C_RESET}
     ${C_DIM}cd ${ORCA_DIR}/package && node dist/index.js${C_RESET}

     The installer will run device-code sign-in inline — no need to run
     ${C_BOLD}az login${C_RESET} yourself first. When it prompts you, open the URL
     it prints in any browser and enter the short code shown. Your
     session persists in the container for subsequent re-runs
     (INTENT-ORCAHQ-104 §104-O).

  ${C_BOLD}2) Enter your licence key when asked${C_RESET}
     You should have received this from your ORCA HQ contact.

The installer will ask for:
  • Your customer slug (3-10 lowercase letters/digits)
  • Azure region (default: uksouth)
  • Custom domain (optional)
  • Which connectors to deploy
  • ORCA HQ ACR deployment token (from your ORCA contact)

Full step-by-step guide with screenshots and troubleshooting:
  ${INSTALL_GUIDE_URL}

EOF
