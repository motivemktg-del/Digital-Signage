# Imagen base la elige build.yaml según arquitectura (amd64/aarch64) —
# son las imágenes oficiales de Home Assistant con Python 3.11 sobre Alpine.
ARG BUILD_FROM
FROM $BUILD_FROM

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# init:false en config.yaml → el Supervisor corre este CMD directo, sin
# s6-overlay de por medio.
CMD ["python3", "ptz_agent.py"]
