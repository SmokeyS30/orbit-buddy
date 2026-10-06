FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /var/data /backup && chown -R node:node /app /var/data /backup && chmod +x ./docker-entrypoint.sh
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/var/data/orbit
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
