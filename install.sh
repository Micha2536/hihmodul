#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf "\033[1;32m[install]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[install]\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m[install]\033[0m %s\n" "$*"; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    err "Bitte als root ausführen (oder mit sudo)."
    exit 1
  fi
}

os_id() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID:-unknown}"
  else
    echo "unknown"
  fi
}

install_docker_linux() {
  require_root

  log "Docker wird installiert (Linux)..."
  if have_cmd apt-get; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
  elif have_cmd dnf; then
    dnf -y install ca-certificates curl
  elif have_cmd yum; then
    yum -y install ca-certificates curl
  elif have_cmd pacman; then
    pacman -Sy --noconfirm ca-certificates curl
  fi

  # Official Docker convenience script (recommended for quick installer)
  curl -fsSL https://get.docker.com | sh

  systemctl enable --now docker || true

  # Add current user to docker group (optional)
  if [[ -n "${SUDO_USER:-}" ]]; then
    usermod -aG docker "$SUDO_USER" || true
    warn "User '$SUDO_USER' wurde zur docker-Gruppe hinzugefügt. Bitte einmal neu einloggen, falls 'permission denied' kommt."
  fi

  log "Docker Installation abgeschlossen."
}

ensure_docker() {
  if have_cmd docker; then
    log "Docker gefunden: $(docker --version 2>/dev/null || true)"
    return 0
  fi

  uname_s="$(uname -s || true)"
  case "$uname_s" in
    Linux)
      log "Docker nicht gefunden. Installation wird gestartet."
      install_docker_linux
      ;;
    Darwin)
      err "Docker ist nicht installiert. Bitte Docker Desktop für macOS installieren und danach erneut ausführen."
      err "https://www.docker.com/products/docker-desktop/"
      exit 1
      ;;
    *)
      err "Unsupported OS: $uname_s. Bitte Docker manuell installieren."
      exit 1
      ;;
  esac
}

ensure_compose() {
  # Compose v2: 'docker compose'
  if docker compose version >/dev/null 2>&1; then
    log "Docker Compose gefunden: $(docker compose version | head -n 1)"
    return 0
  fi

  # Linux: try install plugin package if available
  uname_s="$(uname -s || true)"
  if [[ "$uname_s" == "Linux" ]]; then
    if have_cmd apt-get; then
      require_root
      log "Installiere docker-compose-plugin..."
      apt-get update -y
      apt-get install -y docker-compose-plugin
      return 0
    fi
  fi

  err "Docker Compose (v2) nicht gefunden. Bitte aktualisiere Docker/Compose."
  exit 1
}

prepare_config() {
  mkdir -p "$PROJECT_DIR/data"
  if [[ ! -f "$PROJECT_DIR/data/config.json" ]]; then
    if [[ -f "$PROJECT_DIR/data/config.example.json" ]]; then
      cp "$PROJECT_DIR/data/config.example.json" "$PROJECT_DIR/data/config.json"
      log "data/config.json erstellt aus data/config.example.json"
    else
      warn "data/config.example.json fehlt; lege leere data/config.json an."
      echo "{}" > "$PROJECT_DIR/data/config.json"
    fi
  else
    log "data/config.json existiert bereits."
  fi
}

start_project() {
  log "Starte Projekt via Docker Compose..."
  cd "$PROJECT_DIR"
  docker compose up -d --build
  log "Fertig. WebUI: http://localhost:8100"
}

main() {
  ensure_docker
  ensure_compose
  prepare_config
  start_project
}

main "$@"
