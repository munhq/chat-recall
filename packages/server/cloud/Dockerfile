FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs migrate.mjs ./
COPY migrations ./migrations
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
