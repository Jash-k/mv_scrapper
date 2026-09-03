import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // 1TamilMV Working Mirror URLs (fastest active mirrors first)
  tamilmvMirrors: [
    process.env.TAMILMV_URL || 'https://www.1tamilmv.fi',
    'https://www.1tamilmv.observer',
    'https://www.1tamilmv.meme',
    'https://www.1tamilmv.yt',
    'https://www.1tamilmv.report',
  ],

  // Scrape Limit (Max titles per scrape run)
  maxScrapeLimit: parseInt(process.env.MAX_SCRAPE_LIMIT || '300', 10),

  // Quality Filtering Settings: STRICTLY 720p and 1080p ONLY
  qualitiesAllowed: ['720p', '1080p'],
  exclude4k: true,
  excludeSd: true,

  // Browser Request Headers to bypass Cloudflare/WAF
  browserHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  },

  // High performance public trackers injected into magnet links
  trackers: [
    'udp://tracker.publictracker.xyz:6969/announce',
    'http://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.wildkat.net:6969/announce',
    'udp://tracker.qu.ax:6969/announce',
    'udp://tracker.peerfect.org:6969/announce',
    'udp://tracker.opentrackr.com:6969/announce',
    'udp://tracker.opentorrent.top:6969/announce',
    'udp://tracker.filemail.com:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.filebase.online:6969/announce',
    'udp://tracker.moeking.me:6969/announce',
    'udp://p4p.arenabg.com:1337/announce',
  ],
};
