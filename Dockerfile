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

# curl first — node:18-slim does not ship it, and the deno installer needs it.
RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*

# ⚠️ DENO IS NOT OPTIONAL EITHER, AND ITS ABSENCE WAS SILENT.
# Five yt-dlp call sites pass `--js-runtimes deno`, and deno was never installed
# — so yt-dlp reported `[debug] JS runtimes: none` and simply could not execute
# JavaScript. TikTok now answers a watch-page request with a JS CHALLENGE
# (tiktok.py `_solve_challenge_and_set_cookies`); with no runtime there is
# nothing to solve it with, and the extractor dies on "Unexpected response from
# webpage request". Measured from the server itself: TikTok returns a full
# HTTP 200 page of 394KB with no captcha and no block, so the IP was never the
# problem — a flag was being passed for a binary that did not exist.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- --yes \
  && deno --version

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
