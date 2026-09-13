# Cómo se despliega esto de verdad

Este repo dejó de ser un mock estático — ahora trae el **backend real**
(`venuepro-signage/`), que ya corre en tu VPS de Hostinger vía Docker +
Traefik. Las instrucciones de "Nginx + Certbot" que había aquí antes ya
no aplican (ese plan era para una app estática que no existe más).

## Lo que ya está corriendo en tu VPS

- `https://ds.venueprocrm.cloud` — el backend + la interfaz original,
  contenedor `venuepro-signage-signage-1`, gestionado por Docker Compose
  en `/home/deploy/apps/venuepro-signage` (compose.yml, Traefik lo expone).
- Mi interfaz nueva vive **dentro de ese mismo proyecto**, en
  `venuepro-signage/public/mobile/` — no es un servicio aparte. Una vez
  desplegado el proyecto normal, queda disponible en
  `https://ds.venueprocrm.cloud/mobile/`, sin tocar la interfaz original
  que sigue en `/`.

## Para actualizar el VPS con lo de este repo

El repositorio fuente real de `venuepro-signage/` es
`motivemktg-del/html-front-crm`, rama `codex/saas-control-plane` (carpeta
`DigitalSignage/`) — este repo (`Digital-Signage`) tiene una **copia** para
poder trabajar sobre ella con Claude. Cuando quieras llevar cambios al VPS:

```bash
# en el VPS
cd /home/deploy/apps/dae-crm   # el checkout de la CRM, si ya existe ahí
git pull origin codex/saas-control-plane
bash deploy/update-digital-signage.sh
```

Eso instala la versión actualizada en `/home/deploy/apps/venuepro-signage`
sin pedir setup interactivo (usa `install.sh --agency`). Ver
`venuepro-signage/README.md` para el resto de rutas de despliegue
(instalación nueva con `install.sh`, verificación con `install.sh --check`,
backups de SQLite, etc.) — ya está todo documentado ahí por quien construyó
el backend, no lo repito aquí.

## Multi-agencia / RTSP-ONVIF (fase 2)

Ver `PLAYER_SPEC.md` — el módulo de fuentes en vivo (capturadoras SDI/HDMI,
cámaras PTZ) es trabajo nuevo, no existe todavía en el backend real.
