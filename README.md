# HIH – Module & Konfiguration (Docker)

Dieses Repo enthält den **HIH Manager** (WebUI) + Module (Hue, Shelly, Modbus, …).

- WebUI/Manager läuft standardmäßig auf **Port 8100**
- Konfiguration wird **ausschließlich** nach `./data/config.json` gespeichert (persistiert via Volume)
- Module-WebUIs liegen unter `modules/<name>/webui/`

## Quickstart

## One‑liner Installation (Linux)

```bash
git clone https://github.com/Micha2536/hihmodul.git
cd hihmodul
chmod +x install.sh
sudo ./install.sh
```

## Installation (Windows)

```powershell
git clone https://github.com/Micha2536/hihmodul.git
cd hihmodul
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
 (Docker Compose)

```bash
git clone https://github.com/Micha2536/hihmodul.git
cd hihmodul

mkdir -p data
cp data/config.example.json data/config.json

docker compose up -d --build
```

Danach WebUI öffnen:

- `http://<HOST>:8100`

## Netzwerk-Hinweis (Shelly / MotionBlinds Discovery)

Für mDNS/Multicast (z.B. Shelly Scan) ist auf Linux/RPi meist **host networking** nötig.
Im `docker-compose.yml` ist `network_mode: "host"` bereits gesetzt.

## Daten & Konfiguration

- Persistente Daten: `./data/`
- Konfiguration: `./data/config.json`
- Beispiel: `./data/config.example.json`



## Troubleshooting

### Shelly Scan findet nichts
- Prüfe, ob `avahi-browse` im Container vorhanden ist
- Prüfe Multicast im Netz (WLAN Isolation / VLAN)
- Mit host-network testen (Compose ist bereits auf host).

## Lizenz
Wähle eine Lizenz (z.B. MIT) und füge `LICENSE` hinzu.
