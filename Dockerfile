# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --ignore-scripts; \
    else \
      npm ci --omit=dev --ignore-scripts; \
    fi \
    && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /var/data /backup && chown -R node:node /app /var/data /backup && chmod +x ./docker-entrypoint.sh
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/var/data/orbit
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
