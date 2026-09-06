// Counterfactuals for the challenge classifier and the retry gate.
// No network, no vendor call, free to run.
//
// ⚠️ THE POINT OF THIS FILE IS THE THINGS THAT MUST **NOT** RETRY. A detector
// that is generous about what counts as a challenge turns every permanent
// failure into a slow one, and the caller's budget is small.
import fs from 'node:fs'

const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
function lift(name) {
  const i = src.indexOf(`function ${name}(`)
  if (i < 0) throw new Error('missing ' + name)
  let depth = 0, j = src.indexOf('{', i)
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1) }
  }
  throw new Error('unbalanced ' + name)
}
const CONSTS = ['FULL_PAGE_MIN_BYTES', 'CHALLENGE_BACKOFF_MS', 'MIN_ATTEMPT_MS']
  .map(n => (src.match(new RegExp(`const ${n}\\s*=\\s*[^\\n]+`)) || [''])[0]).join('\n')
const classify = new Function(CONSTS + '\n' + lift('classifyYtdlpError') + '\n return classifyYtdlpError')()
const retry = new Function(
  CONSTS + '\n' + lift('sleep') + '\n' + lift('classifyYtdlpError') + '\n' +
  src.slice(src.indexOf('async function withChallengeRetry'), src.indexOf('\n}\n', src.indexOf('async function withChallengeRetry')) + 2) +
  '\n return withChallengeRetry')()

let pass = 0; const fail = []
const eq = (got, want, label) => { if (got === want) pass++; else fail.push(`  ${label}\n    want ${want}  got ${got}`) }

// ── must RETRY: a transient challenge. Stub-sized or unknown page. ──
for (const m of [
  'ERROR: [TikTok] 7675: Your IP address is blocked from accessing this post',
  'ERROR: [TikTok] Unexpected response from webpage request',
  'ERROR: rate limit exceeded, try again later',
  'ERROR: HTTP Error 429: Too Many Requests',
  'ERROR: please complete the captcha to continue',
  'ERROR: verify you are human to continue',
]) eq(classify(m, 13440), 'challenge', 'challenge (13KB stub): ' + m.slice(0, 52))
eq(classify('ERROR: Your IP address is blocked from accessing this post', null), 'challenge', 'challenge with unknown page size')

// ⚠️ THE FINDING THIS FILE EXISTS FOR. Identical wording, full page, and it is
// reproducible — measured @khaby.lame 4/4 at 367-369KB while @espn extracted
// 4/4 on the same IP seconds apart. Retrying this can never succeed.
for (const b of [367930, 369008, 394000])
  eq(classify('ERROR: [TikTok] 7137: Your IP address is blocked from accessing this post', b), 'video_blocked',
     `per-video block at ${b} bytes must NOT be a challenge`)

// ── must NOT retry: permanent facts about the video ──
for (const [m, w] of [
  ['ERROR: [TikTok] 123: Video unavailable', 'permanent'],
  ['ERROR: [TikTok] 123: This post is private', 'permanent'],
  ['ERROR: Unable to download webpage: HTTP Error 404: Not Found', 'permanent'],
  ['ERROR: [youtube] abc: Video has been removed by the uploader', 'permanent'],
  ['ERROR: The uploader has not made this video available in your country', 'permanent'],
  ['ERROR: [youtube] Sign in to confirm your age', 'permanent'],
]) eq(classify(m, 13440), w, 'permanent: ' + m.slice(0, 52))

// ── must NOT retry: faults in THIS container ──
for (const m of [
  'WARNING: Ignoring unsupported JavaScript runtime(s): node,deno. Supported runtimes: deno, node, bun, quickjs.',
  '[debug] JS runtimes: none\nERROR: ... _solve_challenge_and_set_cookies',
  'ERROR: The extractor is attempting impersonation, but no impersonate target is available',
]) eq(classify(m, null), 'config', 'config: ' + m.slice(0, 52))

// ⚠️ THE TRAP: a missing JS runtime emits the SAME _solve_challenge stack as a
// real challenge (batch 44 lost a debugging round to exactly this). Config must
// win, or a broken image retries until the budget is gone.
eq(classify('[debug] JS runtimes: none\nFile "tiktok.py", line 300, in _solve_challenge_and_set_cookies', 13440),
   'config', 'TRAP: missing-runtime _solve_challenge')

eq(classify('ERROR: <urlopen error [Errno -3] Temporary failure in name resolution>', null), 'unknown', 'unknown fails fast')

// ── the retry gate itself ──
const mk = (msg, bytes) => { const e = new Error(msg); e.webpageBytes = bytes; return e }
const CH = () => mk('ERROR: Your IP address is blocked from accessing this post', 13440)

// a permanent error must not be retried even once
let calls = 0
try {
  await retry(() => { calls++; throw mk('ERROR: This post is private', 13440) }, { deadlineAt: Date.now() + 100000 })
  fail.push('  permanent error did not throw')
} catch (e) { eq(calls, 1, 'permanent error: exactly one attempt'); eq(e.kind, 'permanent', 'permanent error kind') }

// a per-video block must not be retried either
calls = 0
try {
  await retry(() => { calls++; throw mk('ERROR: Your IP address is blocked from accessing this post', 369008) }, { deadlineAt: Date.now() + 100000 })
  fail.push('  video_blocked did not throw')
} catch (e) { eq(calls, 1, 'video_blocked: exactly one attempt'); eq(e.kind, 'video_blocked', 'video_blocked kind') }

// a challenge retries, then succeeds
calls = 0
const got = await retry(() => { calls++; if (calls < 3) throw CH(); return { ok: true } }, { deadlineAt: Date.now() + 100000 })
eq(calls, 3, 'challenge: retried twice then succeeded'); eq(got.ok, true, 'challenge: returned the value')

// ⚠️ THE BUDGET IS RESPECTED. With no room for another attempt it must give up
// immediately rather than fail slower.
calls = 0
const t0 = Date.now()
try {
  await retry(() => { calls++; throw CH() }, { deadlineAt: Date.now() + 3000 })
  fail.push('  exhausted did not throw')
} catch (e) {
  eq(calls, 1, 'tight budget: no retry attempted')
  eq(e.exhausted, true, 'tight budget: marked exhausted')
  if (Date.now() - t0 < 1500) pass++; else fail.push(`  tight budget should fail fast, took ${Date.now() - t0}ms`)
}

// a generous budget exhausts the backoff array and stops
calls = 0
try {
  await retry(() => { calls++; throw CH() }, { deadlineAt: Date.now() + 100000 })
  fail.push('  never-clearing challenge did not throw')
} catch (e) {
  eq(calls, 3, 'never clears: 1 + 2 retries then stops')
  eq(e.exhausted, true, 'never clears: marked exhausted')
}

console.log(`${fail.length ? '⚠️ FAILED' : '✅'} ${pass}/${pass + fail.length} assertions`)
if (fail.length) { console.log(fail.join('\n')); process.exit(1) }
