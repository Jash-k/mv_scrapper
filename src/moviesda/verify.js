/**
 * Build-time verification — the reason this feed stays trustworthy.
 *
 * Every 'mp4' URL must answer a ranged GET with real MP4 bytes (ftyp box)
 * before it is allowed into moviesda.json / the M3U twin. Every 'iframe' URL
 * must serve a player page containing a <video> tag. Anything that fails is
 * dropped and counted — the committed files only ever contain streams that
 * were provably alive minutes earlier.
 */
const TIMEOUT_MS = 20000;

async function rangedHead(url, bytes = 131072) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
        Range: `bytes=0-${bytes - 1}`,
        Referer: 'https://moviesda34.com/',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    // Hard-cap the read: some CDNs ignore Range and return the whole file
    // with 200 — never buffer more than `bytes` into memory.
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < bytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    try { await reader.cancel(); } catch { /* stream already closed */ }
    try { res.body.destroy(); } catch { /* node compat */ }
    return { status: res.status, buf: Buffer.concat(chunks).subarray(0, bytes) };
    return { status: res.status, buf };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyMp4(url) {
  try {
    const { status, buf } = await rangedHead(url);
    const isMp4 = buf.length > 64 && buf.slice(4, 8).toString('latin1') === 'ftyp';
    const isTs = buf.length > 376 && buf[0] === 0x47 && buf[188] === 0x47;
    return { ok: (status === 200 || status === 206) && (isMp4 || isTs), status, bytes: buf.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function verifyEmbed(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' },
        redirect: 'follow',
        signal: controller.signal,
      });
      const body = (await res.text()).slice(0, 40000);
      const hasPlayer = res.ok && (body.includes('<video') || body.includes('?stream=1'));
      const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
      const csp = (res.headers.get('content-security-policy') || '').toLowerCase();
      const framed = !xfo && !csp.includes('frame-ancestors');
      return { ok: hasPlayer && framed, status: res.status, framed };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Run verifiers with bounded concurrency so we stay polite. */
export async function verifyAll(items, checker, { concurrency = 4, onProgress } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = { item: items[index], ...(await checker(items[index].url)) };
      done += 1;
      if (onProgress && done % 10 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
