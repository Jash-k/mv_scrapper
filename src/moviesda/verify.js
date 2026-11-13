import { setTimeout as sleep } from 'node:timers/promises';

const LIMIT = 65536;
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash']);

/** Parse bounded ISO-BMFF boxes. Image/QuickTime/TS signatures are not MP4. */
export function isMp4(buf) {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (size < 8 || offset + size > buf.length) return false;
    if (type === 'ftyp') {
      if (size < 16 || (size - 16) % 4) return false;
      const brands = [buf.toString('latin1', offset + 8, offset + 12)];
      for (let i = offset + 16; i + 4 <= offset + size; i += 4) brands.push(buf.toString('latin1', i, i + 4));
      return brands.some(b => MP4_BRANDS.has(b));
    }
    if (!['free', 'skip', 'wide'].includes(type)) return false;
    offset += size;
  }
  return false;
}

export async function readPrefix(res, max = LIMIT) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let count = 0;
  try {
    while (count < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, max - count);
      chunks.push(part);
      count += part.length;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, count);
}

/** Verify as an ordinary player: no fabricated Referer/cookie required. */
export async function verifyMp4(url, { timeoutMs = 20000, retries = 1 } = {}) {
  let result;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return { ok: false, error: 'invalid-url' };
      if (/onestream/i.test(parsed.hostname)) return { ok: false, error: 'embed-host-rejected' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await fetch(url, { headers: { Range: `bytes=0-${LIMIT - 1}`, 'Accept-Encoding': 'identity' }, redirect: 'follow', signal: controller.signal });
        const status = res.status;
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (![200, 206].includes(status)) {
          await res.body?.cancel();
          result = { ok: false, status, error: 'http-error' };
          if (![408, 429, 500, 502, 503, 504].includes(status)) return result;
        } else {
          const range = res.headers.get('content-range') || '';
          if (status === 206 && !/^bytes 0-\d+\/\d+$/.test(range)) {
            await res.body?.cancel();
            return { ok: false, status, error: 'invalid-content-range' };
          }
          const buf = await readPrefix(res);
          const ok = !/text\/|application\/(?:json|xhtml)/.test(ctype) && isMp4(buf);
          const total = status === 206 ? Number(range.split('/')[1]) : Number(res.headers.get('content-length'));
          return { ok, status, ctype, bytes: buf.length, url: res.url || url,
            size_bytes: Number.isSafeInteger(total) && total > 0 ? total : null,
            verifiedAt: new Date().toISOString(), ...(ok ? {} : { error: 'not-mp4' }) };
        }
      } finally { clearTimeout(timer); }
    } catch (error) { result = { ok: false, error: error.name === 'AbortError' ? 'timeout' : 'network-error' }; }
    if (attempt < retries) await sleep(200 * (attempt + 1));
  }
  return result;
}

export async function verifyAll(items, checker, { concurrency = 4, onProgress } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid verification concurrency');
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { item: items[index], ...(await checker(items[index].url)) }; }
      catch { results[index] = { item: items[index], ok: false, error: 'checker-error' }; }
      done++;
      if (onProgress && done % 10 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
