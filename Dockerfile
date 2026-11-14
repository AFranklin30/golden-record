FROM node:20-alpine AS dashboard
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production
COPY . .
COPY --from=dashboard /web/dist ./web/dist
EXPOSE 3000
CMD ["node", "index.js"]
