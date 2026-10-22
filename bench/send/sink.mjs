// Webhook sink: answers 200 to everything and counts requests. GET /count returns the total.
import http from 'node:http';
let n = 0;
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/count') return res.end(String(n));
  req.resume();
  req.on('end', () => { n++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log('sink up'));
