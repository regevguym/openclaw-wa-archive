import fs from 'fs';
import path from 'path';
import { updateMediaPath } from './db';

const MAX_SIZE_MB = 50;

let mediaDir = '';

export function configureMedia(dataDir: string): void {
  mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
}

export function queueMediaDownload(
  messageId: string,
  url: string,
  mimeType?: string
): void {
  if (!mediaDir || !url) return;

  // Fire and forget — don't block message processing
  downloadMedia(messageId, url, mimeType).catch((err) => {
    console.warn(`[wa-archive] Media download failed for ${messageId}:`, (err as Error).message);
  });
}

async function downloadMedia(
  messageId: string,
  url: string,
  mimeType?: string
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading media`);
  }

  // Check content length
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_SIZE_MB * 1024 * 1024) {
    console.warn(`[wa-archive] Media too large for ${messageId}, skipping`);
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Organize by date
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const dateDir = path.join(mediaDir, yyyy, mm, dd);
  fs.mkdirSync(dateDir, { recursive: true });

  // Determine extension from mime type or URL
  const ext = getExtension(mimeType, url);
  const filename = `${messageId}${ext}`;
  const filePath = path.join(dateDir, filename);

  fs.writeFileSync(filePath, buffer);

  // Update DB with local path
  updateMediaPath(messageId, filePath);
}

function getExtension(mimeType?: string, url?: string): string {
  if (mimeType) {
    const mimeMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'application/pdf': '.pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    };
    if (mimeMap[mimeType]) return mimeMap[mimeType];
  }

  if (url) {
    try {
      const pathname = new URL(url).pathname;
      const extMatch = pathname.match(/\.(\w+)$/);
      if (extMatch) return `.${extMatch[1]}`;
    } catch {
      // Invalid URL, ignore
    }
  }

  return '.bin';
}
