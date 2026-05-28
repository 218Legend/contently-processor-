FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
  nodejs npm ffmpeg curl \
  && pip install yt-dlp \
  && apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3001
CMD ["node", "index.js"]