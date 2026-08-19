FROM node:18-slim

# ⚠️ curl_cffi IS NOT OPTIONAL FOR TIKTOK. yt-dlp needs TLS/JA3 impersonation to
# fetch a TikTok watch page; without it every TikTok analysis dies with
#   WARNING: The extractor is attempting impersonation, but no impersonate
#            target is available
#   ERROR:   Unexpected response from webpage request
# which the API surfaces as the generic "Could not fetch video. The platform may
# be blocking this server." That message sent us looking for datacenter-IP
# blocking; the real cause was a missing pip extra. `yt-dlp[default,curl-cffi]`
# pulls it in. --upgrade matters too: the image layer caches, so an unpinned
# `pip3 install yt-dlp` can serve a build-time-old yt-dlp for months while
# TikTok changes its page shape underneath it.

RUN apt-get update && apt-get install -y \
  python3 python3-pip ffmpeg curl \
  && pip3 install --break-system-packages --upgrade \
       "yt-dlp[default,curl-cffi]" requests \
  && apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3001
CMD ["node", "index.js"]
