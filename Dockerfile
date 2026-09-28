# ---------- 建置 ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts：伺服器不需要下載 Electron
RUN npm ci --ignore-scripts
COPY . .
RUN npx vite build \
 && npx vite build --ssr server/main.ts --outDir dist-server --emptyOutDir

# ---------- 執行 ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
# 網頁版用戶端：放在 client/，啟動時同步到共用 volume public/ 交給 Caddy
# （named volume 只在第一次建立時複製映像內容，所以每次啟動都要重新同步，更新版本才會生效）
COPY --from=build /app/dist ./client
RUN mkdir -p public && chown node:node public
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "rm -rf public/* && cp -r client/. public/ && exec node dist-server/main.js"]
