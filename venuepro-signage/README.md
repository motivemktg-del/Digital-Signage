# VenuePro Digital Signage

Independent application for `https://ds.venueprocrm.cloud`. Tenant-scoped administration, media library, playlists, screen pairing, weekly schedules with IANA timezones, offline Android player and browser test player.

The interface is mobile first, using the dark/teal visual reference supplied by the user. Locations contain screens; tenants contain their own locations, users, media, playlists and schedules. Administrators manage users, editors manage content and screens, and viewers have read-only access. Pausing or requesting synchronization takes effect on the next player poll (normally 20 seconds). Offline players keep the last successfully synchronized state. Archiving an asset is blocked while playlists reference it; deleting an assigned playlist is blocked. Archived binary files are retained for backup, not physically purged from Bunny.

## Local preview

Node 24 and pnpm 11.19.0. Run `pnpm install --frozen-lockfile`, copy `.env.example` to `.env`, set `STORAGE_MODE=local` and `PUBLIC_URL=http://localhost:3080`, then `pnpm start`.

Create each standalone tenant with `ADMIN_PASSWORD` in the environment and `node tenant.js "Company" owner@example.com`. Password must be 12+ characters. Never put credentials in committed files. The browser tests create a **local-only demo**: `demo@signage.local` / `Signage-demo-local-2026`. Do not copy the local `data` directory to production.

The panel is at `/`; `/player.html` shows a short-lived QR/code for a test screen. Pair from the admin panel. The browser player downloads media into IndexedDB, verifies SHA-256, then activates the complete manifest. Its service worker stores only player application files, never admin API responses. Offline reload works after the first complete download. Browser videos are muted for autoplay; Android plays sound. Private/incognito browser storage may be temporary. Scheduling requires a correct device clock.

## Independent VPS deployment

For the existing Hostinger VPS, source is also distributed in the CRM GitHub repository under `DigitalSignage/`. Use the established `deploy` account and `/home/deploy/apps/dae-crm` checkout, pull `codex/saas-control-plane`, then run `bash deploy/update-digital-signage.sh`. The wrapper installs the independent application into the sibling `/home/deploy/apps/venuepro-signage` directory, inherits Bunny settings privately from the running CRM and connects the agency bridge. Its Docker project and SQLite volume remain separate. No PowerShell/SCP transfer is required for this flow.

The wrapper uses `install.sh --agency`, which skips standalone administrator creation so that the agency panel update is not blocked by an interactive account setup. It checks that the running CRM actually serves `agency-signage.js` before reporting completion. Access then starts in Agency Settings → Digital Signage.

The source archive includes `install.sh` and `SHA256SUMS`. Extract it into `/opt/venuepro-signage` and run `sudo bash install.sh`. The interactive installer verifies the package, asks for Traefik's container/network and Bunny credentials on first use, preserves existing `.env` on updates, builds the container, checks internal health, validates Bunny access, verifies public HTTPS and creates the first standalone tenant only when no tenants exist. It does not install Docker or modify the CRM. `bash install.sh --check` validates the package and APK without changing the server. To regenerate the archive from source, run `node scripts/package.mjs`.

1. Place this project in a separate directory (for example `/opt/venuepro-signage`). Do not copy the CRM database or local preview data.
2. Configure server-only `.env`: Bunny Storage host, zone, storage password, `AGENCY_SIGNAGE_SECRET` and `TRAEFIK_NETWORK` matching the existing reverse proxy network. This Compose project uses its own `signage_data` volume and does not expose a public host port.
3. `docker compose config` then `docker compose up -d --build`.
4. Check `https://ds.venueprocrm.cloud/health` and TLS before using cameras. The DNS A record was observed as `31.220.56.107`; DNS alone does not publish the application.
5. Create a tenant inside the container or link real CRM tenants through the agency integration below. Do not run browser tests on production.

SQLite WAL stores tenant metadata, sessions, devices, playlists, schedules and agency links in `/app/data/signage.sqlite`. Use one application replica. Back up SQLite consistently with SQLite's online backup API or stop the container before copying the entire volume. Uploaded production media is stored in Bunny under `signage/<tenant UUID>/<asset UUID>.<extension>`; keep that storage zone private. The backend streams authenticated downloads from Bunny, so Bunny credentials never reach browsers or APKs. CDN signed direct downloads are not implemented.

## Agency integration

The CRM changes live in `Backend/src/signageRoutes.js` and `Frontend/agency-signage.js`. Both applications must receive the same random `AGENCY_SIGNAGE_SECRET` (at least 32 characters). Set CRM `SIGNAGE_URL=https://ds.venueprocrm.cloud`. The agency panel's Settings → Digital Signage lists actual CRM tenants and permits owner/admin roles to link, unlink and open their signage manager. Platform support is read-only. The CRM must be deployed with these changes as well.

There is no shared database: an `agency_links` row maps the CRM tenant UUID to the signage tenant UUID. Server-to-server requests use HMAC, timestamps and single-use nonces. Opening the manager issues a single-use 60-second ticket, transferred in a URL fragment, then exchanged for an HttpOnly session cookie. `/api/signage/access` is also available to an authenticated CRM tenant administrator; tenant identity comes from the verified CRM session.

Unlinking disables new agency tickets, removes pending tickets and revokes active manager sessions for that linked tenant. It preserves signage files, schedules and devices, allowing relinking. Existing downloaded content cannot be remotely removed while a player has no network. Standalone tenants created by CLI are independent. This initial integration has one trusted agency per deployment and does not implement billing or screen license limits.

## Android application

`android/` contains the native Android TV / tablet application, minimum Android 8. It connects to `https://ds.venueprocrm.cloud`, displays a pairing QR, downloads files to private device storage, checks SHA-256 and atomically replaces its offline manifest only after all downloads succeed. Schedules and timezones run locally. MP4 compatibility depends on device codecs; use H.264/AAC media compatible with the target hardware.

Build with JDK 17, Gradle 8.11.1, Android SDK 35 and Build Tools 35.0.0: `gradle -p android assembleDebug`. The debug APK is for testing. A commercial release needs a securely stored signing key and release signing configuration. Hardware startup/kiosk/MDM provisioning and physical device validation remain separate deployment work; the app keeps the display awake while open, but does not claim universal automatic launch after boot.

Prebuilt test APK: `public/downloads/venuepro-signage-test.apk`. This APK uses the real `ds.venueprocrm.cloud` address; that service must be deployed before pairing on hardware. It is not pointed at the local preview server.

## Verification

`pnpm test`: real HTTP/SQLite tests for authentication, tenant isolation, QR expiry/reuse, uploads, manifests, weekly schedules, device revocation, signed agency requests, ticket replay and unlink revocation. `test/browser.cjs` is a local environment browser integration test. It exercises actual APIs, pairing, upload, publication, schedules, mobile widths and offline reload. QR-camera testing on physical phones and playback on Android hardware still require devices.

The browser suite also decodes the generated QR image using the same scanner library as the manager, verifies timezone schedule boundaries, and checks layout at 320, 390, 768 and 1440 pixels. Android debug compilation and Android Lint were run; a compiled APK is not a substitute for hardware playback testing. The CRM bridge has separate authorization/context tests in `Backend/test/signageRoutes.test.js`.

Deployment remains pending until VPS SSH access and server-side Bunny configuration are available. There is no production database migration into the CRM: only a new API bridge and agency-panel section. The new service uses its own SQLite volume and its own Git repository.

## References

- [OptiSigns mobile administration](https://support.optisigns.com/hc/en-us/articles/30003143806099-How-to-Use-the-OptiSigns-Mobile-Admin-App)
- [piSignage offline playback](https://www.pisignage.com/)
- [Android TV application requirements](https://developer.android.com/training/tv/get-started/create)
- [Android Gradle 8.9 compatibility](https://developer.android.com/build/releases/agp-8-9-0-release-notes)
# Gestión de contenido desde Pantallas

El menú Pantallas abre todas las pantallas de la empresa. En cada tarjeta, **Enviar contenido** permite seleccionar una imagen, video o lista y confirmar la publicación. **Subir archivo a la biblioteca** abre la carga existente; después se vuelve a Pantallas para confirmar el envío. Un archivo directo crea o reutiliza una lista de un elemento. Los horarios y la pausa se conservan. El estado de sincronización solo cambia con la confirmación real del reproductor.

La integración nativa CRM usa POST `/api/agency/manage` firmado con HMAC, nonce y vencimiento, con acciones acotadas `state` y `content`. Resuelve exclusivamente vínculos CRM activos. El backend CRM determina la empresa por su sesión autenticada; no transmite credenciales DS al navegador ni usa iframe. Los clientes independientes siguen usando su panel DS.
