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

const cookieFlag = () => (cookiesPath ? `--cookies "${cookiesPath}"` : '')

// ── helpers ────────────────────────────────────────────────────────────────────

function getMetadata(url) {
  const raw = execSync(
    `yt-dlp --dump-json --no-download --no-playlist --js-runtimes deno ${cookieFlag()} "${url}"`,
    { timeout: 30000 }
  ).toString()
  return JSON.parse(raw)
}

function downloadVideo(url, workDir) {
  const outPath = path.join(workDir, 'video.mp4')
  execSync(
    `yt-dlp -f "best[height<=480]/best" --no-playlist --js-runtimes deno ${cookieFlag()} -o "${outPath}" "${url}"`,
    { timeout: 120000 }
  )
  return outPath
}

// Scene-aware contact sheet: extracts frames at actual cuts, falls back to uniform sampling
function makeContactSheet(videoPath, workDir) {
  const sheetPath = path.join(workDir, 'sheet.jpg')

  // Primary: scene-change detection (threshold 0.25 catches most social-media cuts)
  // Creates a tiled grid from all detected cut-points
  try {
    execSync(
      `ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.25)',scale=320:-1,tile=4x6" -vsync vfr -frames:v 1 "${sheetPath}" -y 2>/dev/null`,
      { timeout: 60000 }
    )
    // >5 KB means real frames were extracted (not just a blank grid)
    if (fs.existsSync(sheetPath) && fs.statSync(sheetPath).size > 5000) {
      return sheetPath
    }
  } catch {}

  // Fallback: uniform sampling every 2 seconds — catches static/low-cut videos
  execSync(
    `ffmpeg -i "${videoPath}" -vf "fps=1/2,scale=320:-1,tile=4x6" -frames:v 1 "${sheetPath}" -y`,
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
      "mood_query": "pinterest search query for visual reference 5-8 words"
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
- mood_query: concise Pinterest search for mood/visual reference — e.g. "close up woman mirror selfie fitting room outfit"
- List shots in EXACT chronological order

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
      max_tokens: 4096,
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

  if (req.url === '/process' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      let workDir = null
      try {
        const { url } = JSON.parse(body)
        if (!url) { res.writeHead(400); res.end(JSON.stringify({ error: 'URL required' })); return }

        // 1. Metadata (fast, no download)
        let meta
        try {
          meta = getMetadata(url)
        } catch (ytErr) {
          res.writeHead(422)
          res.end(JSON.stringify({
            error: 'Could not fetch video. The platform may be blocking this server — try a different URL.',
            detail: ytErr.message
          }))
          return
        }
        if (!meta || !meta.title) {
          res.writeHead(422); res.end(JSON.stringify({ error: 'Video metadata missing or empty' })); return
        }

        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contently-'))

        // 2. Download + extract contact sheet + transcribe (best-effort)
        let contactSheetB64 = null
        let transcription = { transcript: '', segments: [], language: 'unknown' }
        try {
          const videoPath = downloadVideo(url, workDir)
          const sheetPath = makeContactSheet(videoPath, workDir)
          contactSheetB64 = fs.readFileSync(sheetPath).toString('base64')
          const audioPath = extractAudio(videoPath, workDir)
          transcription = transcribe(audioPath)
        } catch (mediaErr) {
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
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'Processing failed', detail: err.message }))
      } finally {
        if (workDir) try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
      }
    })
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

const PORT = process.env.PORT || 3001
server.listen(PORT, '0.0.0.0', () => console.log(`Contently processor running on port ${PORT}`))
