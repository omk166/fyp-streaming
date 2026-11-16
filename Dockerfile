FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server.js ./
COPY auth.js ./
COPY rooms.js ./
COPY recording.js ./
COPY transcription.js ./
COPY whiteboard.js ./
COPY audio-test.js ./
COPY scripts/build-audio.mjs scripts/audio-models.mjs ./scripts/
COPY client ./client
COPY public ./public
RUN npm run build
# Model weights for the "Ours" audio mode (pinned and checksum-verified); see README "Audio processing".
RUN npm run audio:models
ENV HOST=0.0.0.0 MEDIA_IP=0.0.0.0
CMD ["npm", "start"]
