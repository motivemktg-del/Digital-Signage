#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "\nLa instalación se detuvo. Revisa el error anterior; puedes ejecutar install.sh nuevamente.\n" >&2' ERR

command -v sha256sum >/dev/null || die 'Falta sha256sum.'
[[ -f SHA256SUMS ]] || die 'Usa el paquete completo de despliegue.'
sha256sum --check --quiet SHA256SUMS || die 'El paquete está incompleto o fue modificado.'
if [[ "${1:-}" == '--check' ]]; then
  printf 'Paquete y APK verificados.\n'
  exit 0
fi
[[ -z "${1:-}" || "${1:-}" == '--agency' ]] || die 'Uso: bash install.sh [--check|--agency]'
agency_mode=false
[[ "${1:-}" != '--agency' ]] || agency_mode=true
[[ -t 0 ]] || die 'Ejecuta desde una terminal interactiva.'
for executable in docker curl openssl; do
  command -v "$executable" >/dev/null || die "Falta $executable."
done
docker info >/dev/null 2>&1 || die 'Docker no está disponible para este usuario. Ejecuta con sudo bash install.sh.'
docker compose version >/dev/null || die 'Se requiere Docker Compose v2.'

if [[ ! -f .env ]]; then
  printf '\nConfiguración inicial de VenuePro Signage\n'
  docker ps --format 'table {{.Names}}\t{{.Image}}'
  read -r -p 'Nombre del contenedor Traefik: ' proxy_container
  [[ -n "$proxy_container" ]] || die 'Indica el contenedor Traefik.'
  proxy_networks=$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' "$proxy_container")
  printf '\nRedes disponibles en ese contenedor:\n%s\n' "$proxy_networks"
  read -r -p 'Red para Signage: ' proxy_network
  found=false
  while IFS= read -r candidate; do
    [[ "$candidate" != "$proxy_network" || -z "$candidate" ]] || found=true
  done <<< "$proxy_networks"
  [[ "$found" == true ]] || die 'La red elegida no pertenece al contenedor.'

  read -r -p 'Host Bunny Storage [storage.bunnycdn.com]: ' bunny_host
  bunny_host=${bunny_host:-storage.bunnycdn.com}
  [[ "$bunny_host" =~ ^([a-z0-9-]+\.)*storage\.bunnycdn\.com$ ]] || die 'Usa el hostname oficial de tu región Bunny Storage.'
  read -r -p 'Nombre de la Storage Zone de Bunny: ' bunny_zone
  [[ "$bunny_zone" =~ ^[a-zA-Z0-9_-]+$ ]] || die 'Nombre de Storage Zone inválido.'
  read -r -s -p 'Contraseña de Bunny Storage: ' bunny_password
  printf '\n'
  [[ -n "$bunny_password" && "$bunny_password" != *"'"* && "$bunny_password" != *$'\r'* ]] || die 'Contraseña vacía o con caracteres que requieren configurar .env manualmente.'
  [[ "$proxy_network" =~ ^[a-zA-Z0-9_.-]+$ ]] || die 'Nombre de red inválido.'
  agency_secret=$(openssl rand -hex 32)
  temp_env=$(mktemp .env.setup.XXXXXX)
  {
    printf 'PORT=3080\nPUBLIC_URL=https://ds.venueprocrm.cloud\nDATA_DIR=/app/data\nSTORAGE_MODE=bunny\n'
    printf "BUNNY_STORAGE_HOST='%s'\n" "$bunny_host"
    printf "BUNNY_STORAGE_ZONE='%s'\n" "$bunny_zone"
    printf "BUNNY_STORAGE_PASSWORD='%s'\n" "$bunny_password"
    printf "TRAEFIK_NETWORK='%s'\n" "$proxy_network"
    printf "AGENCY_SIGNAGE_SECRET='%s'\n" "$agency_secret"
  } > "$temp_env"
  mv -- "$temp_env" .env
  unset bunny_password agency_secret
else
  printf '\nSe conserva la configuración existente de .env.\n'
fi
chmod 600 .env
docker compose config --quiet

printf '\nConstruyendo y levantando Digital Signage…\n'
docker compose up -d --build
container_id=$(docker compose ps -q signage)
[[ -n "$container_id" ]] || die 'No se creó el contenedor de Signage.'
healthy=false
for attempt in {1..30}; do
  container_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
  if [[ "$container_health" == healthy ]]; then healthy=true; break; fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  docker compose logs --tail=60 signage
  die 'Signage no está saludable. Revisa .env y el error del servicio.'
fi

printf '\nVerificando las credenciales de Bunny Storage…\n'
docker compose exec -T signage node --input-type=module -e '
 const { BUNNY_STORAGE_HOST: host, BUNNY_STORAGE_ZONE: zone, BUNNY_STORAGE_PASSWORD: key } = process.env;
 const response = await fetch(`https://${host || "storage.bunnycdn.com"}/${encodeURIComponent(zone)}/`, { headers: { AccessKey: key }, signal: AbortSignal.timeout(15000) });
 await response.body?.cancel();
 if (!response.ok) { console.error(`Bunny Storage rechazó la conexión: HTTP ${response.status}. Revisa .env.`); process.exit(1); }
 console.log("Bunny Storage conectado.");
'

printf '\nVerificando HTTPS público…\n'
public_ok=false
for attempt in {1..12}; do
  if curl --fail --silent --show-error --connect-timeout 5 --max-time 10 https://ds.venueprocrm.cloud/health > /dev/null 2>&1; then public_ok=true; break; fi
  sleep 5
done
if [[ "$public_ok" != true ]]; then
  die 'El servicio interno está saludable, pero HTTPS público no responde. Verifica DNS y las etiquetas websecure/letsencrypt de Traefik en compose.yml.'
fi

tenant_count=$(docker compose exec -T signage node --input-type=module -e '
 import { openStore } from "./store.js";
 const db = openStore(process.env.DATA_DIR); console.log(db.prepare("SELECT COUNT(*) AS n FROM tenants").get().n); db.close();
')
if [[ "$tenant_count" == 0 && "$agency_mode" != true ]]; then
  printf '\nCrea el primer tenant independiente (podrás vincular otros desde la agencia).\n'
  read -r -p 'Nombre de la empresa: ' tenant_name
  read -r -p 'Correo administrador: ' admin_email
  [[ -n "$tenant_name" && "$admin_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die 'Nombre o correo inválido.'
  read -r -s -p 'Contraseña administrador (mínimo 12 caracteres): ' ADMIN_PASSWORD
  printf '\n'
  [[ ${#ADMIN_PASSWORD} -ge 12 ]] || die 'La contraseña debe tener al menos 12 caracteres.'
  read -r -s -p 'Repite la contraseña: ' password_repeat
  printf '\n'
  [[ "$ADMIN_PASSWORD" == "$password_repeat" ]] || die 'Las contraseñas no coinciden.'
  export ADMIN_PASSWORD
  docker compose exec -T -e ADMIN_PASSWORD signage node tenant.js "$tenant_name" "$admin_email"
  unset ADMIN_PASSWORD password_repeat
fi

if [[ "$agency_mode" == true ]]; then
  printf '\nAcceso desde el panel de agencia: Settings → Digital Signage. No se requiere crear otro administrador aquí.\n'
fi

printf '\nInstalación terminada.\n'
printf 'Gestor: https://ds.venueprocrm.cloud\n'
printf 'QR de prueba: https://ds.venueprocrm.cloud/player.html\n'
printf 'APK de prueba: https://ds.venueprocrm.cloud/downloads/venuepro-signage-test.apk\n'
printf '\nPara integrar la agencia, despliega su puente de API y configura allí el mismo AGENCY_SIGNAGE_SECRET de este .env.\n'
