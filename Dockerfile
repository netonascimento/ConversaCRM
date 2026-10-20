# Node 22.13+ (SQLite embutido). O banco fica em /app/data: monte ali um disco persistente
# (no Railway: Volume com mount path /app/data; no Docker: -v conversacrm-data:/app/data).
FROM node:22.13-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
