FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /var/data && chown -R node:node /app /var/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/var/data
EXPOSE 3000
CMD ["node", "server.js"]
