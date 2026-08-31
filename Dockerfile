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
# ⚠️ unzip IS REQUIRED. The deno install script ships a .zip and exits with
#   "Error: either unzip or 7z is required to install Deno"
# if neither is present. That is the trivial reason the first deno layer failed.
RUN apt-get update && apt-get install -y curl ca-certificates unzip && rm -rf /var/lib/apt/lists/*

# ⚠️ DENO IS NOT OPTIONAL EITHER, AND ITS ABSENCE WAS SILENT.
# Five yt-dlp call sites pass `--js-runtimes deno`, and deno was never installed
# — so yt-dlp reported `[debug] JS runtimes: none` and simply could not execute
# JavaScript. TikTok now answers a watch-page request with a JS CHALLENGE
# (tiktok.py `_solve_challenge_and_set_cookies`); with no runtime there is
# nothing to solve it with, and the extractor dies on "Unexpected response from
# webpage request". Measured from the server itself: TikTok returns a full
# HTTP 200 page of 394KB with no captcha and no block, so the IP was never the
# problem — a flag was being passed for a binary that did not exist.
# ⚠️ NON-FATAL ON PURPOSE. An install that hard-fails takes the whole image
# build with it, Railway keeps serving the previous one, and the symptom is
# indistinguishable from "the fix did not work" — which is exactly what happened
# on the first attempt.
# ⚠️ AND NODE IS *NOT* A FALLBACK ON THIS BASE IMAGE. yt-dlp's NodeJsRuntime sets
# MIN_SUPPORTED_VERSION = (22, 0, 0); this is node:18-slim, so node is detected
# and then reported as "node 18.x (unsupported)". deno is the only runtime this
# image can actually run. Bumping the base image to node:22-slim would make the
# `--js-runtimes node` fallback real — deliberately not done here, since that
# changes the app runtime too.
RUN (curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y || true) \
  && (deno --version || echo 'deno unavailable — falling back to node as the JS runtime')

RUN apt-get update && apt-get install -y \
  python3 python3-pip ffmpeg curl \
  # ⚠️ PINNED EXACTLY, ON PURPOSE. This was `--upgrade "yt-dlp[default,curl-cffi]"`,
  # which meant EVERY REDEPLOY silently changed the extractor — batch 49 watched
  # 2026.07.04 → 2026.08.19 arrive on a deploy whose stated purpose was rotating
  # two API keys. Combined with the egress IP also moving per deploy, a deploy
  # that changed nothing could change both the software and the network identity
  # underneath a working system, which makes every failure unbisectable.
  #
  # 2026.08.19 is MEASURED GOOD (2026-08-31): it extracts and fully downloads
  # TikTok from a residential IP, /diag reports extracted:true from Railway, and
  # three real /process runs returned genuine transcripts with v2 shot lists.
  # Nightly (2026.08.30.232658) was tested against the same URLs and is no better
  # — the version was never the variable.
  #
  # ⚠️ TO BUMP: change the number here, deploy, and re-run POST /diag plus one
  # real /process. Never loosen it back to --upgrade; a silent change is what
  # makes the next outage take a day instead of an hour.
  && pip3 install --break-system-packages --upgrade \
       "yt-dlp[default,curl-cffi]==2026.8.19" requests \
  && apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3001
CMD ["node", "index.js"]
