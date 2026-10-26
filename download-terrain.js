/* ============================================================================
   download-terrain.js —— 把 Esri 地形瓦片抓到本地 assets/terrain/{z}/{x}/{y}.png
   用法：node download-terrain.js [最小z] [最大z]
   默认 z=3..8、中国范围（73~135E，18~54N），并发 8，失败重试 3 次。
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ZMIN = parseInt(process.argv[2] || '3', 10);
const ZMAX = parseInt(process.argv[3] || '8', 10);
const BBOX = { w: 73, e: 135, s: 18, n: 54 };
const OUT = path.join(__dirname, 'assets', 'terrain');
const CONCURRENCY = 8;
const RETRY = 3;

const SRC = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/${z}/${y}/${x}`;

function tileRange(z) {
  const n = Math.pow(2, z);
  const lng2x = lng => Math.floor(((lng + 180) / 360) * n);
  const lat2y = lat => {
    const s = Math.sin((lat * Math.PI) / 180);
    return Math.floor(((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n));
  };
  return {
    x0: lng2x(BBOX.w), x1: lng2x(BBOX.e),
    y0: lat2y(BBOX.n), y1: lat2y(BBOX.s)
  };
}

function download(url, dest) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'aq-board-terrain/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(dest, () => {}); res.resume();
        return resolve(false);
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(true)));
    }).on('error', () => { file.close(); fs.unlink(dest, () => {}); resolve(false); });
  });
}

async function getTile(z, x, y) {
  const dir = path.join(OUT, String(z), String(x));
  const dest = path.join(dir, `${y}.png`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 200) return 'skip';
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < RETRY; i++) {
    if (await download(SRC(z, x, y), dest)) return 'ok';
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  return 'fail';
}

(async () => {
  let total = 0, ok = 0, skip = 0, fail = 0;
  const t0 = Date.now();

  for (let z = ZMIN; z <= ZMAX; z++) {
    const r = tileRange(z);
    const nx = r.x1 - r.x0 + 1, ny = r.y1 - r.y0 + 1;
    const count = nx * ny;
    total += count;
    console.log(`z=${z}  tiles=${count}  (x ${r.x0}..${r.x1}, y ${r.y0}..${r.y1})`);

    const jobs = [];
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) jobs.push([z, x, y]);
    }

    let idx = 0;
    const workers = new Array(CONCURRENCY).fill(0).map(async () => {
      while (idx < jobs.length) {
        const [zz, xx, yy] = jobs[idx++];
        const r2 = await getTile(zz, xx, yy);
        if (r2 === 'ok') ok++; else if (r2 === 'skip') skip++; else fail++;
        if ((ok + skip + fail) % 200 === 0) {
          process.stdout.write(`  ... ${ok + skip + fail}/${total}\r`);
        }
      }
    });
    await Promise.all(workers);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n完成：新增 ${ok}，已存在 ${skip}，失败 ${fail}，总计 ${total}，用时 ${secs}s`);
  console.log('目录：' + OUT);
})();
