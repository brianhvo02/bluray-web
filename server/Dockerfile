# syntax=docker/dockerfile:1.7
# Build context: server/ (after `npm run server:build`). See deploy/deploy.sh.
FROM node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# Jellyfin's apt signing key (fingerprint 4918 AABC 486C A052 358D  778D 4902 3CD0 1DE2 1A7B), pinned by checksum.
ADD --checksum=sha256:a0cde241ae297fa6f0265c0bf15ce9eb9ee97c008904a59ab367a67d59532839 \
    https://repo.jellyfin.org/jellyfin_team.gpg.key /etc/apt/keyrings/jellyfin.asc

# jellyfin-ffmpeg (GPL-3.0 build, see NOTICE) with Intel's media driver (iHD) and oneVPL runtime under
# /usr/lib/jellyfin-ffmpeg: the quality levels' encoder (server/src/levels/). It runs as a child process.
ARG JELLYFIN_FFMPEG_VERSION=7.1.4-3-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && chmod 644 /etc/apt/keyrings/jellyfin.asc \
 && echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/jellyfin.asc] https://repo.jellyfin.org/debian bookworm main' > /etc/apt/sources.list.d/jellyfin.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "jellyfin-ffmpeg7=${JELLYFIN_FFMPEG_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    FFMPEG_PATH=/usr/lib/jellyfin-ffmpeg/ffmpeg \
    FFPROBE_PATH=/usr/lib/jellyfin-ffmpeg/ffprobe

WORKDIR /app
COPY dist/server.mjs ./server.mjs
# TheDiscDB index (MIT, see NOTICE), read from env DISCDB_INDEX, default /app/data/discdb-index.json.
COPY data/discdb-index.json ./data/discdb-index.json
# The notices for what the image ships, TheDiscDB's MIT data and jellyfin-ffmpeg among them.
COPY NOTICE ./NOTICE
# Created here so the named volume mounted on /data starts out owned by `node`.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
