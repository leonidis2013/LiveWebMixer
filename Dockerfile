# LiveWebMixer: web-based multitrack mixing console for audio training
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HTTPS_PORT=8443

# ffmpeg converts uploaded tracks to FLAC and Opus, unzip opens multitrack zips,
# openssl makes the self-signed certificate for the https port
RUN apk add --no-cache ffmpeg unzip openssl tzdata

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# songs, scenes, templates and the certificate are kept in /data (a volume, so they survive updates)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 8080: http (fine behind a reverse proxy that adds https). 8443: https with a self-signed certificate.
# Browsers only run the audio engine on https or localhost.
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
