FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server.js ./
COPY client ./client
COPY public ./public
RUN npm run build
ENV HOST=0.0.0.0 MEDIA_IP=0.0.0.0
CMD ["npm", "start"]
