const http = require('http')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Decode YouTube cookies from base64 env var into a temp file on startup
let cookiesPath = null
if (process.env.YT_COOKIES_B64) {
  try {
    cookiesPath = path.join(os.tmpdir(), 'yt-cookies.txt')
    fs.writeFileSync(cookiesPath, Buffer.from(process.env.YT_COOKIES_B64, 'base64'))
    console.log('Loaded YouTube cookies from env')
  } catch (e) {
    console.error('Failed to write cookies file:', e.message)
    cookiesPath = null
  }
}

/**
 * ⚠️ THE JAR IS `YT_COOKIES_B64` — YOUTUBE COOKIES — AND IT WAS BEING SENT TO
 * TIKTOK TOO. That put an unrelated, silently-expiring credential on TikTok's
 * failure surface for no benefit: measured 2026-08-22 with both arms run back to
 * back on ONE egress IP, TikTok extraction succeeds identically with cookies
 * (394,271 bytes) and without (393,900 bytes). YouTube is the path that plausibly
 * needs them (bot checks on the android client), so they now go only there.
 *
 * ⚠️ Pass the URL. A bare cookieFlag() call would silently re-broaden this.
 */
const isYouTube = (u) => /(^|\.)(youtube\.com|youtu\.be)/i.test(String(u || ''))
const cookieFlag = (url) => (cookiesPath && isYouTube(url) ? `--cookies "${cookiesPath}"` : '')

// ⚠️ `--js-runtimes` TAKES ONE RUNTIME AND MUST BE REPEATED — it is NOT a
// comma-separated list. yt-dlp defines it with `callback_kwargs={'delim': None}`,
// so `--js-runtimes node,deno` is parsed as a single runtime literally named
// "node,deno" and produces:
//   WARNING: Ignoring unsupported JavaScript runtime(s): node,deno.
//            Supported runtimes: deno, node, bun, quickjs.
// followed by `[debug] JS runtimes: none` — i.e. it fails EXACTLY like a missing
// binary, which is how it survived a round of debugging. Repeat the flag instead.
// (Note deno is already yt-dlp's default; the flags are explicit on purpose.)

// ── helpers ────────────────────────────────────────────────────────────────────

// ── WHY A yt-dlp FAILURE HAPPENED, WHICH DECIDES WHETHER RETRYING CAN HELP ──
//
// ⚠️ ONLY ONE OF THESE MAY RETRY. Retrying a dead video, a private post or a
// missing pip extra burns the caller's entire budget to fail identically — and
// the caller's budget is small (see BUDGET below). Everything that is not a
// transient platform challenge fails fast.
//
// ⚠️ ORDER IS LOAD-BEARING, AND THIS IS THE SUBTLE ONE. `_solve_challenge` is
// emitted BOTH by a genuine TikTok challenge AND by yt-dlp having no JavaScript
// runtime at all — batch 44 spent a full debugging round on exactly that stack
// trace when the real cause was `--js-runtimes node,deno` being parsed as one
// runtime literally named "node,deno". So config faults are tested FIRST and win.
// If deno ever goes missing again, this must read as config and stop, not retry.
// ⚠️ THE ERROR STRING ALONE CANNOT DECIDE THIS, AND THAT IS THE WHOLE FINDING.
// Measured 2026-09-06 on ONE container, ONE egress IP (152.55.176.57), seconds
// apart and repeatedly:
//   @espn        extracted 2/2, ~394-403 KB page
//   @khaby.lame  FAILED    4/4, ~367-369 KB page, "Your IP address is blocked"
// Ten real videos this product had already analysed: 10/10 extracted, 0 blocked.
// So "IP address is blocked" is emitted for a PER-VIDEO block that is completely
// reproducible — retrying it can never succeed, and doing so burns the caller's
// whole budget to fail identically.
// The transient per-IP challenge is a different animal and it has a different
// FINGERPRINT: batch 49 measured the challenged case receiving a ~13 KB stub
// where the healthy one got ~395 KB. A full page plus a blocked message is a
// verdict about the video. A stub is the platform refusing the connection.
// SIZE is the discriminator; the words are the same either way.
const FULL_PAGE_MIN_BYTES = 100000
function classifyYtdlpError(msg, webpageBytes) {
  const m = String(msg || '')
  // a fault in this container. Retrying cannot fix our own image.
  if (/Ignoring unsupported JavaScript runtime|JS runtimes:\s*none|no impersonate target is available|impersonate target is not available/i.test(m)) return 'config'
  // a permanent fact about this video. Another attempt returns the same thing.
  if (/Video unavailable|not available|has been removed|is private|does not exist|content isn.t available|HTTP Error 4(0[0-9]|1[0-9])|deleted|available in your country|age.?restrict|Sign in to confirm/i.test(m)) return 'permanent'
  // the transient per-IP challenge — the ONLY thing worth another attempt.
  const looksChallenged = /IP address is blocked|blocked from accessing|_solve_challenge|Unexpected response from webpage|rate.?limit|too many requests|captcha|verify.{0,12}human/i.test(m)
  if (looksChallenged) {
    // a FULL page that still says "blocked" is a decision about this video
    if (typeof webpageBytes === 'number' && webpageBytes >= FULL_PAGE_MIN_BYTES) return 'video_blocked'
    return 'challenge'
  }
  return 'unknown'
}

// ── HOW LONG MAY WE SPEND, AND HOW HARD MAY WE TRY ──────────────────────────
//
// ⚠️ THE BUDGET IS THE CALLER'S, NOT OURS. /process is called client-side from
// the app and server-side by the cron, and the cron runs under Vercel's
// maxDuration 120. Analysis itself is 27-70s. A retry budget that outlives the
// caller's timeout does not rescue anything — it just fails slower and holds a
// container open while it does. Callers may pass budgetMs; the default leaves
// the cron real headroom.
const DEFAULT_BUDGET_MS = 100000
const MIN_ATTEMPT_MS    = 12000   // no point starting a try we cannot finish
//
// ⚠️ THE BACKOFF IS DELIBERATELY SHORT, AND THE MEASUREMENT IS WHY IT IS NOT
// LONGER. The brief asked whether a challenge clears in seconds or hours, because
// the answer picks the architecture. Measured 2026-09-06: ten real videos 10/10,
// @espn 4/4, all on the IP that was reported blocked earlier the same day — so
// the reported challenge HAD ALREADY CLEARED ON ITS OWN, with no deploy. That
// bounds it at under a few hours and gives exactly ONE transition, which is not
// enough to justify a long in-request backoff. It IS enough to justify cheap
// insurance against a momentary blip. Two short attempts, ~8s of added wall
// clock at worst.
// If a future measurement shows challenges lasting minutes, this array is the
// only thing that changes — and if it shows hours, the honest answer is a queue,
// not a bigger array here.
const CHALLENGE_BACKOFF_MS = [2000, 6000]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * Runs `fn`, retrying ONLY a transient platform challenge and only while the
 * caller's deadline leaves room for another attempt.
 * ⚠️ Everything that is not `challenge` rethrows immediately — a dead video, a
 * private post, a per-video block or a broken image must fail fast.
 */
async function withChallengeRetry(fn, { deadlineAt, onRetry }) {
  let attempt = 0
  for (;;) {
    try { return fn() }
    catch (e) {
      const kind = classifyYtdlpError(e.message, e.webpageBytes)
      e.kind = kind
      if (kind !== 'challenge') throw e
      const wait = CHALLENGE_BACKOFF_MS[attempt]
      const left = deadlineAt - Date.now()
      if (wait === undefined || left < wait + MIN_ATTEMPT_MS) {
        e.exhausted = true
        e.attempts = attempt + 1
        throw e
      }
      attempt++
      if (onRetry) onRetry({ attempt, waitMs: wait, msLeft: left })
      await sleep(wait)
    }
  }
}

// ⚠️ `-v` IS LOAD-BEARING, NOT NOISE. It is the only way to learn HOW BIG a page
// TikTok actually served, and that number is the difference between a failure
// worth retrying and one that never will be (see classifyYtdlpError). Verbose
// output goes to stderr, so stdout stays pure JSON.
function getMetadata(url) {
  try {
    const raw = execSync(
      `yt-dlp -v --dump-json --no-download --no-playlist --js-runtimes deno --js-runtimes node ${cookieFlag(url)} "${url}"`,
      { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString()
    return JSON.parse(raw)
  } catch (e) {
    const log = String(e.stderr || '') + String(e.stdout || '') + String(e.message || '')
    const err = new Error((log.match(/ERROR:.*/) || [e.message])[0])
    err.ytLog = log
    err.webpageBytes = (() => { const m = /Webpage size:\s*(\d+)/.exec(log); return m ? Number(m[1]) : null })()
    throw err
  }
}

function downloadVideo(url, workDir) {
  const outPath = path.join(workDir, 'video.mp4')
  execSync(
    `yt-dlp -f "best[height<=480]/best" --no-playlist --js-runtimes deno --js-runtimes node ${cookieFlag(url)} -o "${outPath}" "${url}"`,
    { timeout: 120000 }
  )
  return outPath
}

// ── YouTube long-form LEARNER (batch 11, Part B) ────────────────────────────────
// The autonomous "brain" learns from long creator masterclasses/interviews. Both
// operations are captions/metadata only — NO video download, NO Whisper. The
// android player_client + deno JS runtime + cookies get past YouTube's 2024-25
// SABR/poToken gating that broke the naive caption endpoint.

// Search YouTube for LONG-FORM candidates. Flat-playlist = fast (one search page,
// no per-video extraction); filter to >= minDuration seconds in JS.
function ytSearchLong(query, count, minDuration) {
  const q = String(query).replace(/["`$\\]/g, ' ').slice(0, 120)
  const raw = execSync(
    `yt-dlp "ytsearch${count}:${q}" --flat-playlist --dump-json --no-warnings ` +
    `--extractor-args "youtube:player_client=android" --js-runtimes deno --js-runtimes node ${cookieFlag('https://youtube.com')}`,
    { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }
  ).toString()
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      const dur = Number(e.duration) || 0
      if (!e.id || dur < minDuration) continue
      out.push({
        id: e.id,
        url: `https://www.youtube.com/watch?v=${e.id}`,
        title: e.title || '',
        channel: e.channel || e.uploader || '',
        durationSec: dur,
      })
    } catch {}
  }
  return out
}

// Fetch the FULL transcript from YouTube auto/manual captions — no download.
function ytTranscript(url) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-cap-'))
  try {
    execSync(
      `yt-dlp --skip-download --write-auto-subs --write-subs --sub-langs "en.*" --sub-format json3 ` +
      `--extractor-args "youtube:player_client=android" --js-runtimes deno --js-runtimes node ${cookieFlag('https://youtube.com')} ` +
      `-o "${path.join(workDir, 'cap.%(ext)s')}" "${url}"`,
      { timeout: 90000 }
    )
    const file = fs.readdirSync(workDir).find(f => f.endsWith('.json3'))
    if (!file) return { transcript: '' }
    const d = JSON.parse(fs.readFileSync(path.join(workDir, file), 'utf8'))
    const transcript = (d.events || [])
      .flatMap(e => (e.segs || []).map(s => s.utf8 || ''))
      .join('').replace(/\s+/g, ' ').trim()
    return { transcript }
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  }
}

// Direct-media path: fetch an mp4 straight from a CDN url (e.g. Instagram reels
// resolved via the Apify Instagram scraper, since yt-dlp can't page-fetch IG
// without a login cookie). curl is in the image (see Dockerfile).
function downloadDirect(mediaUrl, workDir) {
  const outPath = path.join(workDir, 'video.mp4')
  // ⚠️ `-f` IS NOT OPTIONAL. Without it curl EXITS 0 ON AN HTTP 403 and writes
  // the error body into the output file, so an expired/blocked CDN url produced
  // a tiny "video" and the generic "returned an empty file" — hiding the status
  // that would have said which of the two it was. `-w` gives us the code even on
  // success, so the message can name it.
  // (Measured 2026-08-22: a FRESH Instagram CDN url downloads fine with plain
  // curl — 17.4MB, HTTP 200, no User-Agent and no Referer required. The
  // signed-url/headers theory is disproved; don't re-add headers for it.)
  let status = '000'
  try {
    status = execSync(
      `curl -fsSL --max-time 120 -w '%{http_code}' -o "${outPath}" "${mediaUrl}"`,
      { timeout: 130000 }
    ).toString().trim()
  } catch (e) {
    const code = (e.stdout || '').toString().trim() || 'no response'
    throw new Error(`Direct media download failed (HTTP ${code})`)
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10000) {
    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0
    throw new Error(`Direct media download returned ${size} bytes (HTTP ${status}) — too small to be a video`)
  }
  return outPath
}

// Scene-aware contact sheet: extracts frames at actual cuts, falls back to uniform sampling
function makeContactSheet(videoPath, workDir) {
  const sheetPath = path.join(workDir, 'sheet.jpg')

  // Primary: scene-change detection — cap at 4x5=20 frames; threshold 0.25 catches subtler cuts
  try {
    execSync(
      `ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.25)',scale=280:-1,tile=4x5" -vsync vfr -frames:v 1 "${sheetPath}" -y 2>/dev/null`,
      { timeout: 60000 }
    )
    if (fs.existsSync(sheetPath) && fs.statSync(sheetPath).size > 5000) {
      return sheetPath
    }
  } catch {}

  // Fallback: uniform sampling every 4 seconds — capped at 20 frames (4x5 grid)
  execSync(
    `ffmpeg -i "${videoPath}" -vf "fps=1/4,scale=280:-1,tile=4x5" -frames:v 1 "${sheetPath}" -y`,
    { timeout: 60000 }
  )
  return sheetPath
}

function extractAudio(videoPath, workDir) {
  const audioPath = path.join(workDir, 'audio.mp3')
  execSync(
    `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -ar 16000 -ac 1 "${audioPath}" -y`,
    { timeout: 60000 }
  )
  return audioPath
}

function transcribe(audioPath) {
  try {
    const raw = execSync(`python3 transcribe.py "${audioPath}"`, { timeout: 180000 }).toString()
    return JSON.parse(raw)
  } catch (e) {
    console.error('Transcription failed:', e.message)
    return { transcript: '', segments: [], language: 'unknown' }
  }
}

async function analyseWithClaude(meta, contactSheetB64, transcription) {
  const transcriptText = transcription.transcript || '(no speech detected)'
  const segmentSummary = (transcription.segments || [])
    .slice(0, 30)
    .map(s => `[${s.start}-${s.end}s] ${s.text}`)
    .join('\n')

  const prompt = `You are a professional video director analysing a viral short-form video to produce a shot-by-shot recreation brief for a creator.

You are given:
1. A CONTACT SHEET: frames captured at scene changes, left→right / top→bottom = chronological order. Each cell = one real cut point.
2. A TRANSCRIPT with timestamps.
3. Video metadata.

Metadata:
Title: ${meta.title}
Duration: ${meta.duration}s
Views: ${meta.view_count}
Uploader: ${meta.uploader}

Transcript:
${transcriptText}

Timestamped segments:
${segmentSummary || '(none)'}

Return ONLY a valid JSON object — no markdown, no backticks, just the raw JSON:

{
  "_v": 2,
  "hook_style": "One sentence: what specifically happens in the first 1-3 seconds to grab attention",
  "pacing": "One sentence on cut rhythm and energy level",
  "audio_style": "One sentence: voice-driven / music-driven / mix, beat-cut moments",
  "cta": "The closing call-to-action or 'none'",
  "script_notes": "Core message and narrative arc in 1-2 sentences",
  "edit_brief": "Key post-production notes: text overlays, music feel, color grade, transitions",
  "effort_rating": 7,
  "difficulty_reason": "One sentence: what specifically makes this hard or easy to recreate",
  "filming_needs": ["concrete item 1", "concrete item 2", "concrete item 3"],
  "shot_types": [
    {
      "section": "hook",
      "type": "talking_head",
      "framing": "Camera angle and composition — e.g. Medium close-up, face centered, static",
      "action": "What the person physically does — e.g. Walks toward camera smiling",
      "script": "Exact words spoken in this shot, or 'no dialogue'",
      "duration_sec": 3,
      "text_overlay": "On-screen text/caption visible, or 'none'",
      "audio_note": "Music cue / beat drop / SFX / silence note for this shot",
      "energy": 4,
      "tip": "One specific actionable tip to nail this exact shot",
      "visual_subject": "Identify the SINGLE most important visual element that defines this shot — the focal point a viewer's eye goes to first. Then note 1-2 supporting context elements only if they matter. Lead with the hero element. Example: if a hand holds a coffee cup in a room, the hero is 'hand holding coffee cup' and the room is minor context. Don't inventory the whole frame — find what MAKES the shot.",
      "search_query": "3-5 word literal image-search query centered on the HERO visual element from visual_subject. Lead with the most important physical thing. Drop minor details (clothing colors, background) unless they ARE the point. The query should retrieve a photo where the hero element is the clear subject. Example: 'hand holding coffee cup' NOT 'person grey shirt room window coffee morning'.",
      "action_query": "3-5 word literal Pinterest image query for the physical ACTION or pose happening in this shot. Hero element = what the person/hands are DOING. Example: 'hands adding toppings popcorn', 'woman walking toward camera street', 'person holding product up'. Same banned-words rules: no emotion words, no camera jargon. If the shot has no meaningful action (static product, text card), mirror the hero object or scene instead.",
      "scene_query": "3-5 word literal Pinterest image query for the SETTING or environment of this shot. Hero element = the place. Example: 'outdoor farmers market booth', 'modern kitchen counter morning', 'city street sidewalk daytime'. Same banned-words rules: no emotion words, no camera jargon."
    }
  ]
}

Rules for shot_types array:
- One entry per DISTINCT CUT. Group consecutive frames that look like one continuous shot.
- section must be exactly one of: hook / body / cta
  - hook: the opening 1-3 seconds — the pattern interrupt that stops the scroll. Usually the first 1-2 shots.
  - body: everything in the middle — the proof, story, demo, retention beats
  - cta: the closing ask — "follow for more", "comment below", "link in bio". Usually the final 1-2 shots. If no explicit CTA, mark the last shot 'cta' anyway.
- type must be exactly one of: talking_head / b_roll / transition / text_card
  - talking_head: person directly addressing camera
  - b_roll: supplementary footage (product, location, action without direct camera address)
  - transition: quick movement/zoom/spin used as a cut device
  - text_card: frame is primarily on-screen text
- framing: use exact terms — extreme close-up / close-up / medium / wide / overhead / POV
- script: quote transcript text if it matches this shot's timecode, else 'no dialogue'
- text_overlay: quote any visible captions or stickers exactly as shown, else 'none'
- energy: 1 (calm/slow) to 5 (high energy/fast)
- tip: be specific to THIS shot — not generic advice
- visual_subject: identify the ONE hero visual element that defines the shot — the thing a viewer's eye goes to first. Add 1-2 supporting context elements only if they meaningfully change what photo you'd search for. Don't inventory the frame.
- search_query: 3-5 words centered on the hero element from visual_subject. Lead with the most important physical thing.
  PRIORITIZE: every shot has one hero (the product, the face, the hands doing the action, the object). Lead the query with it.
  Don't over-describe: 3-5 words max. Too many nouns returns generic/wrong images.
  BANNED: emotion words (thinking, deciding, satisfied, excited, etc.), camera jargon (close-up, medium, angle), abstract verbs (looking, considering). If the action is "deciding", describe the VISIBLE thing instead (e.g. "woman at food counter").
  For talking-head shots: lead with the concrete person + setting ("woman at market booth"), not emotions or micro-expressions.
  GOOD: "popcorn container toppings hands" / "silver laptop desk" / "woman pink apron food booth"
  BAD: "woman customer pink shirt necklace deciding order" / "person thinking looking up conversation"
  The query should retrieve a STOCK PHOTO where the hero element is the clear, unambiguous subject.
- action_query: 3-5 words for the physical ACTION or pose — what the person/hands are DOING. Banned: emotion words, camera jargon. If no meaningful action (static product, text card), use the hero object or scene instead.
- scene_query: 3-5 words for the SETTING or environment — the place. Banned: emotion words, camera jargon. Example: "outdoor farmers market booth", "modern kitchen counter morning".
- Do NOT generate a framing query — cinematography terms return junk images and framing is handled separately in the UI.
- List shots in EXACT chronological order
- Maximum 16 shots total — group similar consecutive frames into one shot if needed

Difficulty scale for effort_rating (be honest — overrating is better than underrating):
1-2: Single talking head, one location, under 30s, no effects
3-4: Talking head plus 1-3 B-roll shots, one location
5-6: Multiple locations OR fast cuts over 1 per second OR music sync required
7-8: Fast-cut montage, 3+ locations, heavy B-roll, text overlays, beat cuts throughout
9-10: Advanced effects, color grade, multi-day shoot, choreography, 30+ cuts

filming_needs: list 3-5 specific items the creator needs. Be concrete — not "good lighting" but "ring light or natural window light". Include locations, props, equipment, wardrobe if relevant.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: contactSheetB64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  })

  const data = await response.json()
  if (!data.content || !data.content[0]) {
    console.error('Claude response unexpected:', JSON.stringify(data))
    throw new Error('Claude returned no content: ' + JSON.stringify(data))
  }
  const raw  = data.content[0].text || ''
  const text = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
  if (!text) throw new Error('Claude returned empty text. Stop reason: ' + data.stop_reason)
  console.log('[claude] stop_reason:', data.stop_reason, '| text length:', text.length, '| last 120 chars:', JSON.stringify(text.slice(-120)))
  try {
    return JSON.parse(text)
  } catch (parseErr) {
    console.error('[claude] JSON parse failed. First 300:', text.slice(0, 300))
    throw parseErr
  }
}

// ── server ─────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

  if (req.url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({ status: 'ok', service: 'contently-processor' }))
    return
  }

  // ── /diag — FREE DIAGNOSTIC, no download, no Apify, no Anthropic ────────────
  // ⚠️ THIS EXISTS BECAUSE "Could not fetch video. The platform may be blocking
  // this server" is a CONCLUSION, not evidence. That message survived weeks of
  // being read as "TikTok blocks datacenter IPs" while the real cause was a
  // missing pip extra (curl_cffi, fixed in c28e9cf). The raw error was always in
  // `detail`; what was missing was everything AROUND it — what TikTok actually
  // returns to this machine, and from which IP.
  // Returns: yt-dlp's full verbose stderr, the HTTP status + first bytes TikTok
  // serves this server, and the egress IP. Nothing here costs money.
  // ⚠️ A GET HERE USED TO 404 WITH {"error":"Not found"}, WHICH READS EXACTLY LIKE
  // A DEPLOY THAT NEVER LANDED — and cost real debugging time on 2026-08-31, when
  // the endpoint was in fact live and healthy. A diagnostic that lies about its
  // own existence is worse than no diagnostic.
  if (req.url === '/diag' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      endpoint: '/diag',
      usage: 'POST /diag with {"url":"<a TikTok watch url>"} — runs yt-dlp verbosely both with and without cookies, a plain curl of the watch page, and reports the egress IP, yt-dlp version and impersonation targets.',
      note: 'This is a diagnostic, not the analysis path. POST /process is the real one.',
      example: `curl -X POST -H 'Content-Type: application/json' -d '{"url":"https://www.tiktok.com/@espn/video/7675192516739681567"}' ${req.headers.host ? 'https://' + req.headers.host : ''}/diag`,
    }))
    return
  }
  if (req.url === '/diag' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      const out = {}
      let url = ''
      try { url = String(JSON.parse(body || '{}').url || '') } catch {}
      if (!url) { res.writeHead(400); res.end(JSON.stringify({ error: 'url required' })); return }
      const run = (cmd, ms) => {
        try { return { ok: true, out: execSync(cmd, { timeout: ms, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString().slice(0, 4000) } }
        catch (e) { return { ok: false, out: String(e.stdout || '').slice(0, 2000), err: String(e.stderr || e.message || '').slice(0, 6000) } }
      }
      out.egressIp   = run('curl -s -m 12 https://ifconfig.me', 15000)
      out.ytdlpVer   = run('yt-dlp --version', 15000)
      out.impersonate= run('yt-dlp --list-impersonate-targets 2>&1 | head -20', 20000)
      // what does TikTok actually SERVE this machine? status + a slice of the body.
      out.plainCurl  = run(`curl -s -m 20 -o /tmp/tt.html -w '%{http_code} %{size_download}' -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' "${url.replace(/"/g, '')}"`, 25000)
      out.bodyHead   = run("head -c 700 /tmp/tt.html | tr -d '\\n'", 8000)
      out.bodySignals= run("grep -o -i -m1 -E 'captcha|verify|robot|access denied|blocked|__UNIVERSAL_DATA|SIGI_STATE|login' /tmp/tt.html | head -5", 8000)
      // ⚠️ BOTH ARMS IN ONE CALL, ON PURPOSE. The processor's egress IP CHANGES
      // ON EVERY DEPLOY (measured 2026-08-22: 13.52.165.77 → 152.55.176.108
      // across the key redeploy), and TikTok's behaviour tracks the IP — so a
      // with-cookies run now compared against a without-cookies run after the
      // next deploy compares two different machines and proves nothing. Run the
      // variable you are testing against a CONSTANT IP, in the same moment.
      const ytCmd = (extra) =>
        `yt-dlp -v --dump-json --no-download --no-playlist --js-runtimes deno --js-runtimes node ${extra} "${url.replace(/"/g, '')}" 2>&1 | tail -40`
      out.ytdlpVerbose   = run(ytCmd(cookieFlag(url)), 90000)
      out.ytdlpNoCookies = run(ytCmd(''), 90000)
      // The size yt-dlp's own (impersonated) request receives is the tell: the
      // real watch page is ~395KB, a challenge stub is ~13KB. Compare against
      // plainCurl above, which is the same host with no cookies and no
      // impersonation.
      const sizeOf = (o) => { const m = /Webpage size: (\d+)/.exec(String(o && o.out || '')); return m ? Number(m[1]) : null }
      const okOf   = (o) => /"id":\s*"\d+"/.test(String(o && o.out || ''))
      out.summary = {
        withCookies:    { webpageBytes: sizeOf(out.ytdlpVerbose),   extracted: okOf(out.ytdlpVerbose) },
        withoutCookies: { webpageBytes: sizeOf(out.ytdlpNoCookies), extracted: okOf(out.ytdlpNoCookies) },
        cookiesPresent: Boolean(cookieFlag(url)), cookieJarLoaded: Boolean(cookiesPath),
      }
      res.writeHead(200)
      res.end(JSON.stringify(out, null, 1))
    })
    return
  }

  if (req.url === '/process' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      let workDir = null
      try {
        const { url, videoUrl, meta: metaIn, budgetMs } = JSON.parse(body)
        // the caller owns the ceiling; clamp so a bad value cannot hold a
        // container open or make the retry pointless
        const budget = Math.max(20000, Math.min(Number(budgetMs) || DEFAULT_BUDGET_MS, 240000))
        const deadlineAt = Date.now() + budget
        if (!url && !videoUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'URL or videoUrl required' })); return }

        // 1. Metadata. Direct-media path (Instagram via Apify): the caller supplies
        //    metadata + a direct CDN url, since yt-dlp can't page-fetch Instagram.
        //    Otherwise resolve metadata with yt-dlp from the page url (TikTok/YT).
        let meta
        if (videoUrl) {
          meta = {
            title:      (metaIn && metaIn.title) || 'Untitled',
            duration:   metaIn && metaIn.duration,
            view_count: metaIn && metaIn.view_count,
            like_count: metaIn && metaIn.like_count,
            uploader:   (metaIn && metaIn.uploader) || '',
            thumbnail:  (metaIn && metaIn.thumbnail) || null,
          }
        } else {
          try {
            meta = await withChallengeRetry(() => getMetadata(url), {
              deadlineAt,
              onRetry: ({ attempt, waitMs, msLeft }) =>
                console.log(`[challenge] attempt ${attempt} failed, waiting ${waitMs}ms (${Math.round(msLeft / 1000)}s of budget left)`),
            })
          } catch (ytErr) {
            // ⚠️ "TRY A DIFFERENT URL" IS THE WRONG ADVICE FOR THE FAILURE THIS
            // ACTUALLY HITS, and it sent two investigations down the wrong path.
            // Measured 2026-08-22: TikTok answers SOME of this service's egress
            // IPs with a ~13KB challenge stub instead of the ~395KB watch page —
            // same yt-dlp, same curl_cffi, same impersonation target, same
            // cookies, different container. It is per-IP and TRANSIENT, and the
            // egress IP changes on every deploy, so another URL fails exactly the
            // same way while a redeploy fixes it. Say that instead.
            const m = String(ytErr.message || '')
            const kind = ytErr.kind || classifyYtdlpError(m, ytErr.webpageBytes)
            // ⚠️ FOUR CAUSES, AND ONLY ONE OF THEM WAS EVER WORTH ANOTHER ATTEMPT.
            // They used to collapse into one message that told the creator to try
            // a different URL — advice that is wrong for three of the four.
            const say = {
              // reproducible, and another attempt cannot change it
              video_blocked: 'TikTok will not serve this particular video to this server. Other videos are unaffected — it is this post, not your connection.',
              // transient, and we already spent the budget retrying it
              challenge: ytErr.exhausted
                ? `The platform challenged this server on every attempt (${ytErr.attempts || 1}). It affects every video, not this one, and it usually clears on its own within the hour.`
                : 'The platform is challenging this server right now. It affects every video, not this one — it usually clears on its own.',
              // our image is broken. Retrying costs 40s to fail identically.
              config: 'This server is misconfigured for video extraction — a missing JavaScript runtime or impersonation target. This is our fault, not the video.',
              permanent: 'That video is not available — it may be private, removed, or restricted where this server runs.',
              unknown: 'Could not fetch that video.',
            }[kind] || 'Could not fetch that video.'
            res.writeHead(422)
            res.end(JSON.stringify({
              error: say,
              detail: m,
              cause: kind === 'challenge' ? 'platform_challenge' : kind,
              ...(typeof ytErr.webpageBytes === 'number' ? { webpage_bytes: ytErr.webpageBytes } : {}),
              ...(ytErr.exhausted ? { retried: ytErr.attempts, budget_ms: budget } : {}),
            }))
            return
          }
          if (!meta || !meta.title) {
            res.writeHead(422); res.end(JSON.stringify({ error: 'Video metadata missing or empty' })); return
          }
        }

        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contently-'))

        // 2. Download + extract contact sheet + transcribe (best-effort)
        let contactSheetB64 = null
        let degradedReason = null
        let transcription = { transcript: '', segments: [], language: 'unknown' }
        try {
          const videoPath = videoUrl ? downloadDirect(videoUrl, workDir) : downloadVideo(url, workDir)
          const sheetPath = makeContactSheet(videoPath, workDir)
          contactSheetB64 = fs.readFileSync(sheetPath).toString('base64')
          const audioPath = extractAudio(videoPath, workDir)
          transcription = transcribe(audioPath)
        } catch (mediaErr) {
          // ⚠️ A FAILED DOWNLOAD USED TO RETURN A CLEAN `success: true` WITH AN
          // EMPTY SHOT LIST. That writes a benchmark which LOOKS analysed —
          // the "analysis not captured" stub class that Settings' Re-analyze
          // exists to clean up, except nothing marked it. Still non-fatal
          // (metadata-only beats nothing), but it is now DECLARED, so the caller
          // can tell a real analysis from a hollow one without guessing from
          // refusal text.
          degradedReason = mediaErr.message
          console.error('Media processing failed, falling back to metadata-only:', mediaErr.message)
        }

        // 3. Analyse with Claude Vision
        let analysis
        if (contactSheetB64) {
          analysis = await analyseWithClaude(meta, contactSheetB64, transcription)
        } else {
          // No frames available — safe v2 defaults
          analysis = {
            _v: 2,
            hook_style: 'Could not fully analyse video content — frames unavailable',
            shot_types: { _v: 2, shots: [], difficulty_reason: 'Video frames unavailable — re-analyse for full breakdown', filming_needs: [] },
            pacing: 'unknown',
            audio_style: transcription.transcript ? 'voice-driven (from transcript only)' : 'unknown',
            cta: 'none',
            script_notes: transcription.transcript ? transcription.transcript.slice(0, 200) : meta.title,
            edit_brief: 'Re-run analysis when video frames are accessible',
            effort_rating: 5,
            difficulty_reason: 'Video frames unavailable',
            filming_needs: []
          }
        }

        // Build v2 shot_types wrapper.
        // Claude now returns the full v2 object; shot_types field contains the shots array.
        // We store the wrapper {_v:2, shots, difficulty_reason, filming_needs} as shot_types.
        const shotsArray = Array.isArray(analysis.shot_types) ? analysis.shot_types : []
        const shotTypesV2 = {
          _v:                2,
          shots:             shotsArray,
          difficulty_reason: analysis.difficulty_reason ?? null,
          filming_needs:     Array.isArray(analysis.filming_needs) ? analysis.filming_needs : [],
        }

        res.writeHead(200)
        res.end(JSON.stringify({
          success: true,
          // ⚠️ TRUE WHEN THE VIDEO ITSELF WAS NEVER SEEN. The payload is still
          // usable metadata, but nothing here came from watching the video.
          ...(degradedReason ? { degraded: true, degraded_reason: degradedReason } : {}),
          data: {
            title:         meta.title,
            duration:      meta.duration,
            view_count:    meta.view_count,
            like_count:    meta.like_count,
            uploader:      meta.uploader,
            thumbnail:     meta.thumbnail,
            transcript:    transcription.transcript,
            url,
            hook_style:    analysis.hook_style   ?? null,
            shot_types:    shotTypesV2,
            pacing:        analysis.pacing        ?? null,
            audio_style:   analysis.audio_style   ?? null,
            cta:           analysis.cta           ?? null,
            script_notes:  analysis.script_notes  ?? null,
            edit_brief:    analysis.edit_brief    ?? null,
            effort_rating: analysis.effort_rating ?? null,
          }
        }))

      } catch (err) {
        console.error('Error:', err.message)
        // ⚠️ AN INVALID KEY IS A CONFIGURATION FAULT, NOT A BAD VIDEO, AND MUST
        // NOT READ AS ONE. On 2026-08-22 the processor's ANTHROPIC_API_KEY went
        // stale (the app's own key was fine — Railway holds a SEPARATE copy) and
        // every analysis on BOTH platforms died with a flat "Processing failed".
        // It was reported as "Instagram analysis is failing" and cost a full
        // investigation, because the message named neither the cause nor the
        // fact that it applied to everything.
        const m = String(err.message || '')
        const isAuth = /authentication_error|API key is invalid|invalid_api_key|401|permission_error/i.test(m)
        res.writeHead(isAuth ? 503 : 500)
        res.end(JSON.stringify({
          error: isAuth
            ? 'The analyser is not configured on the server (its API key was rejected) — this affects every video, not just this one.'
            : 'Processing failed',
          detail: m,
          ...(isAuth ? { cause: 'processor_api_key' } : {}),
        }))
      } finally {
        if (workDir) try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
      }
    })
    return
  }

  // YouTube learner: find long-form candidates for a search query.
  // POST { query, count?, minDuration? } → { success, candidates:[{id,url,title,channel,durationSec}] }
  if (req.url === '/yt-search' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { query, count, minDuration } = JSON.parse(body || '{}')
        if (!query || typeof query !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'query required' })); return }
        const candidates = ytSearchLong(query, Math.min(Number(count) || 15, 25), Number(minDuration) || 2400)
        res.writeHead(200)
        res.end(JSON.stringify({ success: true, candidates }))
      } catch (err) {
        console.error('yt-search error:', err.message)
        res.writeHead(200)
        res.end(JSON.stringify({ success: false, error: 'yt_search_failed', detail: err.message, candidates: [] }))
      }
    })
    return
  }

  // YouTube learner: fetch a video's full transcript (captions only, no download).
  // POST { url } → { success, transcript, chars }
  if (req.url === '/yt-transcript' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { url } = JSON.parse(body || '{}')
        if (!url || typeof url !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'url required' })); return }
        const { transcript } = ytTranscript(url)
        res.writeHead(200)
        res.end(JSON.stringify({ success: !!transcript, transcript: transcript || '', chars: (transcript || '').length }))
      } catch (err) {
        console.error('yt-transcript error:', err.message)
        res.writeHead(200)
        res.end(JSON.stringify({ success: false, error: 'yt_transcript_failed', detail: err.message, transcript: '', chars: 0 }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

const PORT = process.env.PORT || 3001
server.listen(PORT, '0.0.0.0', () => console.log(`Contently processor running on port ${PORT}`))
