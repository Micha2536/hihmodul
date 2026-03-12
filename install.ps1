\
#requires -Version 5.1
<#
.SYNOPSIS
  Installer for Windows: checks Docker, installs Docker Desktop via winget if missing, then starts the project.

.NOTES
  - Requires Administrator privileges for install.
  - After Docker Desktop install, a reboot or logoff may be required.
#>

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Log($msg) { Write-Host "[install] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[install] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "[install] $msg" -ForegroundColor Red }

function Test-Cmd($name) { return $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

function Ensure-Docker {
  if (Test-Cmd "docker") {
    Write-Log ("Docker gefunden: " + (docker --version))
    return
  }

  Write-Warn "Docker nicht gefunden. Versuche Docker Desktop via winget zu installieren..."
  if (-not (Test-Cmd "winget")) {
    Write-Err "winget nicht verfügbar. Bitte Docker Desktop manuell installieren: https://www.docker.com/products/docker-desktop/"
    exit 1
  }

  $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Err "Bitte PowerShell als Administrator starten und erneut ausführen."
    exit 1
  }

  winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements

  Write-Warn "Docker Desktop installiert. Bitte Docker Desktop starten. Danach dieses Script erneut ausführen."
  exit 0
}

function Ensure-Compose {
  try {
    docker compose version | Out-Null
    Write-Log ("Docker Compose gefunden: " + (docker compose version | Select-Object -First 1))
  } catch {
    Write-Err "Docker Compose v2 nicht verfügbar. Bitte Docker Desktop aktualisieren."
    exit 1
  }
}

function Prepare-Config {
  $dataDir = Join-Path $ProjectDir "data"
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $cfg = Join-Path $dataDir "config.json"
  if (-not (Test-Path $cfg)) {
    $example = Join-Path $dataDir "config.example.json"
    if (Test-Path $example) {
      Copy-Item $example $cfg
      Write-Log "data/config.json erstellt aus data/config.example.json"
    } else {
      "{}" | Out-File -Encoding utf8 $cfg
      Write-Warn "config.example.json fehlt; leere data/config.json erstellt."
    }
  } else {
    Write-Log "data/config.json existiert bereits."
  }
}

function Start-Project {
  Write-Log "Starte Projekt via Docker Compose..."
  Push-Location $ProjectDir
  docker compose up -d --build
  Pop-Location
  Write-Log "Fertig. WebUI: http://localhost:8100"
}

Ensure-Docker
Ensure-Compose
Prepare-Config
Start-Project
