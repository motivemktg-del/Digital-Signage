FROM node:24-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.19.0 && pnpm install --prod --frozen-lockfile
COPY server.js store.js tenant.js agency.js studio.js ./
COPY public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV PORT=3080 DATA_DIR=/app/data
EXPOSE 3080
CMD ["node", "server.js"]
