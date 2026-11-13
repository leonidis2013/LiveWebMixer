# LiveWebMixer: web-based multitrack mixing console for audio training
FROM node:22-trixie-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HTTPS_PORT=8443 \
    PIP_NO_CACHE_DIR=1

# ffmpeg converts uploaded tracks to FLAC and Opus, unzip opens multitrack and plugin zips,
# openssl makes the self-signed certificate for the https port.
# python + pedalboard host Linux VST3 plugins; Xvfb and the X/font/sound libraries are what
# most plugins expect to find even when no window is shown.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg unzip openssl tzdata ca-certificates python3 python3-pip xvfb \
      libx11-6 libxext6 libxrandr2 libxinerama1 libxcursor1 libxrender1 libfreetype6 libfontconfig1 \
      libasound2t64 libgl1 libcurl4t64 \
 && pip3 install --break-system-packages pedalboard \
 && apt-get purge -y python3-pip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js vsthost.py ./
COPY lib ./lib
COPY public ./public

# songs, scenes, templates, plugins and the certificate are kept in /data (a volume, so they survive updates)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 8080: http (fine behind a reverse proxy that adds https). 8443: https with a self-signed certificate.
# Browsers only run the audio engine on https or localhost.
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
