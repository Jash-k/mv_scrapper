/**
 * Build-time verification — only real direct MP4 bytes may enter moviesda.json.
 *
 * Every 'mp4' URL must answer a ranged GET with real MP4 bytes (ftyp box)
 * before it is allowed into moviesda.json / the M3U twin. Anything that fails
 * (HTML gate pages, expired tokens, timeouts) is dropped.
 *
 * Embed / iframe verification removed — this module is direct-links only.
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
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
    try {
      res.body.destroy?.();
    } catch {
      /* node compat */
    }
    return {
      status: res.status,
      ctype: (res.headers.get('content-type') || '').toLowerCase(),
      buf: Buffer.concat(chunks).subarray(0, bytes),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyMp4(url) {
  try {
    // Reject known embed / HTML gate hosts up front
    if (/onestream\.today|play\.onestream/i.test(url)) {
      return { ok: false, error: 'embed-host-rejected' };
    }
    const { status, ctype, buf } = await rangedHead(url);
    // HTML gate pages often answer 200/206 with text/html — reject hard
    if (ctype.includes('text/html') || ctype.includes('text/plain')) {
      return { ok: false, status, error: 'html-gate', bytes: buf.length };
    }
    const isMp4 = buf.length > 64 && buf.slice(4, 8).toString('latin1') === 'ftyp';
    const isTs = buf.length > 376 && buf[0] === 0x47 && buf[188] === 0x47;
    const ok = (status === 200 || status === 206) && (isMp4 || isTs);
    return { ok, status, bytes: buf.length, ctype };
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return results;
}
