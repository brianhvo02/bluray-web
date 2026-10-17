# Build context: server/ (after `npm run server:build`). See deploy/deploy.sh.
FROM node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY dist/server.mjs ./server.mjs
# Created here so the named volume mounted on /data starts out owned by `node`.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
