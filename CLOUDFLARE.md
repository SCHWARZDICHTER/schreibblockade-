# Schreibblockade

Eine Datei: `worker.js`. Die kopierst du in den Cloudflare Worker-Editor (STRG+A → STRG+V → Speichern und bereitstellen).

## Dateien

| Datei | Zweck |
|---|---|
| [worker.js](./worker.js) | Kompletter Worker: Seite + API + Digistore24 + D1 |
| [d1.sql](./d1.sql) | D1-Schema (Backup). Der Worker legt die Tabellen auch selbst an. |

Direkt-Download:
- https://raw.githubusercontent.com/SCHWARZDICHTER/schreibblockade/main/worker.js
- https://raw.githubusercontent.com/SCHWARZDICHTER/schreibblockade/main/d1.sql

## Cloudflare

1. Worker → Code bearbeiten → ganzen Inhalt von `worker.js` einfügen → **Speichern und bereitstellen**
2. Settings → Bindings → D1: Name **`DB`** (genau so), deine bestehende Datenbank (dieselbe wie Tintenkiller, damit Logins geteilt werden)
3. Settings → Variables / Secrets:
   - `VENICE_API_KEY`
   - `XAI_API_KEY`
   - `DIGISTORE24_IPN_PASSWORD`
4. Digistore24 IPN-URL: `https://DEINE-DOMAIN/ipn/digistore24`

Admin-Reiter nur für `machtohnemacht@gmail.com` und `etmfilm@gmail.com`.

## Handy

Kein Play Store, keine APK. Im Handy-Browser: Menü → **Zum Home-Bildschirm**. Dann ist es eine App. Diktieren über das Mikrofon.
