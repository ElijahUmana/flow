// Sharpness of a screenshot region: decode PNG to gray via ffmpeg, score with mean squared gradient (higher = sharper).
import { execFileSync } from 'node:child_process';
export function gray(png) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: png }).toString().trim().split(',').map(Number);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { input: png, maxBuffer: 1 << 28 });
  return { w: probe[0], h: probe[1], px: raw };
}
export function score(img, r) {
  const { w, px } = img; let s = 0, n = 0;
  const x0 = Math.max(1, Math.round(r.x)), y0 = Math.max(1, Math.round(r.y)), x1 = Math.min(img.w - 1, Math.round(r.x + r.w)), y1 = Math.min(img.h - 1, Math.round(r.y + r.h));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * w + x, gx = px[i + 1] - px[i - 1], gy = px[i + w] - px[i - w]; s += gx * gx + gy * gy; n++; }
  return n ? s / n : 0;
}
export function diff(a, b, r) {
  let s = 0, n = 0;
  for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y++) for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x++) { const i = y * a.w + x; s += Math.abs(a.px[i] - b.px[i]); n++; }
  return n ? s / n : 0;
}




