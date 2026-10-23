FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server.js ./
COPY client ./client
COPY public ./public
RUN npm run build
ENV HOST=0.0.0.0 MEDIA_IP=0.0.0.0
CMD ["npm", "start"]
