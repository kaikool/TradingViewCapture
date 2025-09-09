# Dockerfile
FROM node:20-slim

# fonts (để text trong PNG hiển thị chuẩn, nhẹ nhàng)
RUN apt-get update && apt-get install -y \
    fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Nếu ảnh lớn có thể tăng RAM V8
# ENV NODE_OPTIONS=--max-old-space-size=512

CMD ["node", "app.js"]
