FROM node:18-slim

RUN apt-get update && apt-get install -y \
  python3 python3-pip ffmpeg curl \
  && pip3 install yt-dlp requests --break-system-packages \
  && apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3001
CMD ["node", "index.js"]
