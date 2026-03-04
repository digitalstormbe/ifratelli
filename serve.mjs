import { createServer } from 'http';
import { readFile, stat, writeFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8080;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// ── Instagram API config ──
const IG_CONFIG_PATH = join(__dirname, 'instagram.json');
let igCache = { data: null, ts: 0 };
const IG_CACHE_TTL = 60 * 60 * 1000; // 1 hour cache

async function getIgConfig() {
  try {
    const raw = await readFile(IG_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchInstagramPosts() {
  // Return cache if fresh
  if (igCache.data && Date.now() - igCache.ts < IG_CACHE_TTL) {
    return igCache.data;
  }

  const config = await getIgConfig();
  if (!config || !config.access_token) {
    return { error: 'Instagram not configured. Create instagram.json with your access_token.' };
  }

  const igId = config.instagram_account_id;
  if (!igId) {
    return { error: 'Missing instagram_account_id in instagram.json' };
  }

  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  const limit = 6;
  const url = `https://graph.facebook.com/v21.0/${igId}/media?fields=${fields}&limit=${limit}&access_token=${config.access_token}`;

  try {
    const resp = await fetch(url);
    const json = await resp.json();

    if (json.error) {
      return { error: json.error.message };
    }

    // Filter to images and carousels (use thumbnail for videos), map to simple format
    const posts = (json.data || [])
      .slice(0, 3)
      .map(p => ({
        id: p.id,
        image: p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url,
        caption: p.caption || '',
        link: p.permalink,
        date: p.timestamp,
      }));

    igCache = { data: { posts }, ts: Date.now() };
    return { posts };
  } catch (e) {
    return { error: 'Failed to fetch Instagram: ' + e.message };
  }
}

async function refreshToken(token) {
  try {
    const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`;
    const resp = await fetch(url);
    const json = await resp.json();
    return json.access_token || null;
  } catch {
    return null;
  }
}

// ── Server ──
createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // Instagram API endpoint
  if (urlPath === '/api/instagram') {
    const data = await fetchInstagramPosts();
    const cacheHeader = data.error ? 'no-store' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': cacheHeader });
    res.end(JSON.stringify(data));
    return;
  }

  // Static files
  let path = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = join(__dirname, path);
  const ext = '.' + filePath.split('.').pop();
  const contentType = MIME[ext] || 'application/octet-stream';

  try {
    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(filePath).pipe(res);
    }
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => console.log(`Serving on http://localhost:${PORT}`));
