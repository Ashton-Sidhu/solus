# solus-apps-runtime: the program that runs one deployed app
# (docs/plans/app-deploy.md §5.1). The image is the same for each app. It holds
# no app: Solus sends each built version, and the runtime keeps it in /data.
#
# Build context: dist/apps-runtime, made by `bun scripts/build-apps-runtime.ts`.
ARG NODE_VERSION=24.18.0
FROM node:${NODE_VERSION}-bookworm-slim

ENV NODE_ENV=production \
    SOLUS_DATA_DIR=/data \
    SOLUS_LOG_STDOUT=1 \
    PORT=8080

# The data of the app, its versions, and its call log. A volume here makes a
# new container on the same data the same app.
RUN mkdir -p /data /app && chown node:node /data
COPY --chown=node:node runtime.js /app/runtime.js
COPY --chown=node:node drizzle /app/drizzle

USER node
WORKDIR /app
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/_solus/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "/app/runtime.js"]
