import { createServer, type Server } from 'node:http'
import { bridge } from './client.js'

/** Request a Plaid link_token from Bridge for a customer. */
export const createPlaidLinkToken = (customerId: string) =>
  bridge.post(`/customers/${customerId}/plaid_link_requests`, {})

/** Exchange a Plaid public_token with Bridge (server-side only). */
export const exchangePublicToken = (linkToken: string, publicToken: string) =>
  bridge.post(`/plaid_exchange_public_token/${linkToken}`, { public_token: publicToken }, { skipIdempotency: true })

/** Build the Plaid Link HTML page. No secrets are embedded — only the link_token. */
function buildHtml(linkToken: string, port: number): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Bridgerton — Plaid Link</title>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
</head>
<body>
<p id="s">Opening Plaid Link...</p>
<script>
var s=document.getElementById('s');
var h=Plaid.create({
  token:${JSON.stringify(linkToken)},
  onSuccess:function(pt){
    s.textContent='Linking account...';
    fetch('http://localhost:${port}/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({public_token:pt})})
      .then(function(r){return r.json()})
      .then(function(){s.textContent='Done - you can close this tab.'})
      .catch(function(){s.textContent='Exchange failed. Check terminal.'});
  },
  onExit:function(e){
    s.textContent=e?(e.display_message||e.error_message||'Error'):'Cancelled. Reload to retry.';
    fetch('http://localhost:${port}/exit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:e})});
  }
});
h.open();
</script>
</body>
</html>`
}

/** Run the full Plaid Link flow: get link_token, serve HTML, exchange public_token. */
export async function runPlaidLinkFlow(customerId: string): Promise<Record<string, unknown>> {
  // 1. Get link_token from Bridge
  const linkRes = await createPlaidLinkToken(customerId) as Record<string, unknown>
  const linkToken = linkRes.link_token as string | undefined
  if (!linkToken) {
    return { error: 'Failed to get link_token from Bridge', details: linkRes }
  }

  console.error(`\n  ✓ Got link_token: ${linkToken.slice(0, 20)}...`)
  console.error(`    Expires: ${linkRes.link_token_expires_at}`)

  // 2. Start local server on an ephemeral port
  return new Promise((resolve) => {
    let server: Server

    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      // CORS headers for the local page
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'GET' && req.url === '/') {
        const port = (server.address() as import('node:net').AddressInfo).port
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(buildHtml(linkToken, port))
        return
      }

      if (req.method === 'POST' && req.url === '/exit') {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          const { error } = JSON.parse(body || '{}') as { error?: { display_message?: string; error_message?: string } }
          const msg = error?.display_message || error?.error_message || 'User cancelled'
          console.error(`\n  ✗ Plaid Link exited: ${msg}. Waiting for retry...`)
          res.writeHead(200)
          res.end()
        })
        return
      }

      if (req.method === 'POST' && req.url === '/exchange') {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', async () => {
          try {
            const { public_token } = JSON.parse(body) as { public_token: string }
            console.error(`\n  ✓ Received public_token, exchanging with Bridge...`)
            const result = await exchangePublicToken(linkToken, public_token) as Record<string, unknown>
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
            if (result.message) {
              console.error(`  ✓ ${result.message}. Shutting down.\n`)
            } else {
              console.error(`  ✗ Exchange failed. Shutting down.\n`)
            }
            server.close()
            resolve(result)
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(e) }))
          }
        })
        return
      }

      res.writeHead(404)
      res.end('Not found')
    }

    server = createServer(handler)
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address() as import('node:net').AddressInfo
      const localUrl = `http://localhost:${port}`
      console.error(`  ✓ Local server running at ${localUrl}`)
      console.error(`  ✓ Opening browser...\n`)

      // Open browser (cross-platform)
      const { exec } = await import('node:child_process')
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      exec(`${cmd} ${localUrl}`)
    })
  })
}
