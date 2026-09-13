# Desplegar en tu VPS de Hostinger

La app (`app/`) es HTML/CSS/JS estático — no hay build, no hay Node.js que
mantener en el VPS. Se copian los archivos y Nginx los sirve.

## 1. En tu VPS (Hostinger, Ubuntu)

Conéctate por SSH (Hostinger te da el usuario/IP en el hPanel → VPS → detalles):

```bash
ssh root@TU_IP_DEL_VPS
```

Instala Nginx y Git si no los tienes:

```bash
apt update && apt install -y nginx git certbot python3-certbot-nginx
```

## 2. Trae el código desde GitHub

```bash
cd /var/www
git clone https://github.com/TU_USUARIO/TU_REPO.git venuepro-signage
```

(Si el repo es privado, Hostinger te pedirá usuario/token de GitHub la
primera vez, o configura una clave SSH de despliegue.)

## 3. Configura Nginx

Crea `/etc/nginx/sites-available/venuepro-signage`:

```nginx
server {
    listen 80;
    server_name TU_DOMINIO.com;           # o la IP si aún no tienes dominio
    root /var/www/venuepro-signage/app;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html; # para que funcione la navegación interna
    }
}
```

Actívalo:

```bash
ln -s /etc/nginx/sites-available/venuepro-signage /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 4. HTTPS (recomendado, gratis)

Si ya apuntaste un dominio/subdominio a la IP del VPS (esto se hace en
Hostinger → Dominios → DNS, un registro `A` hacia la IP del VPS):

```bash
certbot --nginx -d TU_DOMINIO.com
```

Certbot edita el `server{}` de arriba y renueva el certificado solo.

## 5. Actualizar cuando cambies algo

Manual, cada vez que quieras publicar cambios:

```bash
cd /var/www/venuepro-signage
git pull origin main
```

## 6. (Opcional) Despliegue automático con GitHub Actions

Si quieres que cada `git push` a `main` despliegue solo, dímelo y te dejo un
workflow (`.github/workflows/deploy.yml`) que hace `ssh` al VPS y corre el
`git pull` de arriba — solo necesitas guardar la IP del VPS y una clave SSH
como "secrets" en GitHub (Settings → Secrets → Actions).

---

## Nota sobre lo que es front-end y lo que no

Esta app es el panel de control (front-end, con datos de ejemplo por
ahora — ver los comentarios en `app/js/data.js`). El control real de
capturadoras SDI/HDMI, cámaras PTZ (ONVIF/RTSP) y cualquier dispositivo
ESP32/ESPHome del local necesita un **servidor local por ubicación** que
sí esté en la LAN del restaurante — eso es trabajo de backend aparte, no
algo que resuelva un sitio estático en el VPS. El VPS coordina; el
servidor local de cada ubicación es quien de verdad abre esas conexiones.
