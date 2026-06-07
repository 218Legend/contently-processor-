const http = require('http')
const { execSync } = require('child_process')

async function analyseWithClaude(meta) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Analyse this viral video and return ONLY a JSON object with no markdown or backticks:
{"hook_style":"one sentence","shot_types":["shot 1","shot 2"],"pacing":"one sentence","cta":"one sentence","script_notes":"one sentence","edit_brief":"one sentence","effort_rating":4}

Title: ${meta.title}
Duration: ${meta.duration} seconds
Views: ${meta.view_count}
Description: ${(meta.description || '').slice(0, 500)}`
      }]
    })
  })
  const data = await reconst http = require('http')
const { execSync } = re.stringify(data))
  const text = data.content[0].text.replace(/```json|```/g, '').trim()
  return JSON.parse(text)
}

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
      try {
        const { url } = JSON.parse(body)
        if (!url) { res.writeHead(400); res.end(JSON.stringify({ error: 'URL required' })); return }
        const raw = execSync(`yt-dlp --dump-json --no-download "${url}"`, { timeout: 30000 }).toString()
        const meta = JSON.parse(raw)
        const analysis = await analyseWithClaude(meta)
        res.writeHead(200)
        res.end(JSON.stringify({ success: true, data: { title: meta.title, duration: meta.duration, view_count: meta.view_count, like_count: meta.like_count, uploader: meta.uploader, thumbnail: meta.thumbnail, url, ...analysis } }))
      } catch (err) {
        console.error('Error:', err.message)
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'Processing failed', detail: err.message }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

const PORT = process.env.PORT || 3001
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`))
