const http = require('http')
const { execSync } = require('child_process')

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  if (req.url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({ status: 'ok', service: 'contently-processor' }))
    return
  }

  if (req.url === '/process' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const { url } = JSON.parse(body)
        if (!url) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'URL required' }))
          return
        }
        const raw = execSync(`yt-dlp --dump-json --no-download "${url}"`, { timeout: 30000 }).toString()
        const meta = JSON.parse(raw)
        res.writeHead(200)
        res.end(JSON.stringify({
          success: true,
          data: {
            title: meta.title,
            duration: meta.duration,
            view_count: meta.view_count,
            like_count: meta.like_count,
            uploader: meta.uploader,
            thumbnail: meta.thumbnail,
            description: meta.description,
            url: url,
          }
        }))
      } catch (err) {
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`)
})
