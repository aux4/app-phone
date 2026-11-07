// Local development TLS gateway. Platform remains responsible for SSO and APIs.
import https from 'node:https';
import http from 'node:http';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const hostname = process.env.PHONE_PREVIEW_HOST || '127.0.0.1';
const port = Number(process.env.PHONE_HTTPS_PORT || 9443);
const caPort = Number(process.env.PHONE_CA_PORT || 9444);
const upstreamPort = Number(process.env.PHONE_PLATFORM_PORT || 9100);
const certDir = resolve(process.env.PHONE_CERT_DIR || join(homedir(), '.aux4.config/app-phone/certs'));
await mkdir(certDir, { recursive: true, mode: 0o700 });
const certFile = join(certDir, 'cert.pem');
const keyFile = join(certDir, 'key.pem');
// mkcert uses the existing local CA; it never sends keys to a remote service.
execFileSync('mkcert', ['-cert-file', certFile, '-key-file', keyFile, hostname, 'localhost', '127.0.0.1', 'local.aux4.io'], { stdio: ['ignore', 'ignore', 'inherit'] });
await chmod(keyFile, 0o600);
const caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
const ca = await readFile(join(caRoot, 'rootCA.pem'));
const server = https.createServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (req, res) => {
  const proxy = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method,
    headers: { ...req.headers, host: `${hostname}:${upstreamPort}`, 'x-forwarded-proto': 'https' } }, upstream => {
    const headers = { ...upstream.headers };
    // Same-host redirects remain on the secure preview. The configured OAuth
    // callback URI is deliberately left unchanged inside the SSO authorize URL.
    if (typeof headers.location === 'string' && headers.location.startsWith(`http://${hostname}:${upstreamPort}/`)) {
      headers.location = headers.location.replace(`http://${hostname}:${upstreamPort}`, `https://${hostname}:${port}`);
    }
    res.writeHead(upstream.statusCode, headers);
    upstream.pipe(res);
  });
  proxy.on('error', () => { res.writeHead(502); res.end('Platform unavailable'); });
  req.on('aborted', () => proxy.destroy());
  req.pipe(proxy);
});
// Bootstrap serves only the PUBLIC development CA, never any private key.
const bootstrap = http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/local-ca.crt') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="aux4-local-ca.crt"', 'Cache-Control': 'no-store' });
  res.end(ca);
});
server.listen(port, '0.0.0.0', () => console.log(`Phone: https://${hostname}:${port}/apps/phone/`));
bootstrap.listen(caPort, '0.0.0.0', () => console.log(`Local development CA: http://${hostname}:${caPort}/local-ca.crt`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); bootstrap.close(); });
