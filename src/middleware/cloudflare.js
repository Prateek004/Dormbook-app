'use strict';
/**
 * Real visitor IP when the site is behind Cloudflare (orange-cloud proxy).
 *
 * Path of a request:  phone → Cloudflare → Railway edge → this app.
 * With 'trust proxy' = 1, req.ip is the address that connected to Railway —
 * behind Cloudflare that is a Cloudflare server, shared by many users. Rate limits
 * and sign-in back-off would then lump strangers together and lock people out.
 *
 * Cloudflare sends the real visitor IP in the CF-Connecting-IP header. That header
 * is trusted ONLY when the request really came from a Cloudflare address
 * (official list: https://www.cloudflare.com/ips/). Anyone calling the Railway URL
 * directly cannot fake it. Works the same with or without Cloudflare — no setting needed.
 */
const net = require('net');

const CF_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CF_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32'];

const cfList = new net.BlockList();
for (const c of CF_V4) { const [a, p] = c.split('/'); cfList.addSubnet(a, Number(p), 'ipv4'); }
for (const c of CF_V6) { const [a, p] = c.split('/'); cfList.addSubnet(a, Number(p), 'ipv6'); }

/** '::ffff:1.2.3.4' → '1.2.3.4'; returns '' for anything that is not an IP. */
function normalise(ip) {
  let s = String(ip || '').trim();
  if (s.toLowerCase().startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  return net.isIP(s) ? s : '';
}

function isCloudflare(ip) {
  const s = normalise(ip);
  if (!s) return false;
  try { return cfList.check(s, net.isIPv4(s) ? 'ipv4' : 'ipv6'); } catch (_) { return false; }
}

function cloudflareRealIp(req, res, next) {
  try {
    const hop = req.ip;
    const header = req.headers['cf-connecting-ip'];
    if (header && isCloudflare(hop)) {
      const real = normalise(Array.isArray(header) ? header[0] : header);
      if (real) Object.defineProperty(req, 'ip', { value: real, configurable: true, enumerable: true, writable: true });
    }
  } catch (_) { /* keep the normal req.ip */ }
  next();
}

module.exports = { cloudflareRealIp, isCloudflare, normalise };
