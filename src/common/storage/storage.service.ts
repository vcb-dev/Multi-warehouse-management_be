import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Lưu file local — MVP; production thay bằng S3-compatible */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly uploadDir: string;
  private readonly publicBaseUrl: string;

  constructor() {
    this.uploadDir =
      process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
    const port = process.env.PORT ?? '3001';
    this.publicBaseUrl =
      process.env.PUBLIC_UPLOAD_URL ?? `http://localhost:${port}/uploads`;
  }

  async saveImage(
    buffer: Buffer,
    originalName: string,
  ): Promise<{ url: string; path: string }> {
    await fs.mkdir(this.uploadDir, { recursive: true });
    const ext = path.extname(originalName) || '.jpg';
    const filename = `${randomUUID()}${ext}`;
    const filePath = path.join(this.uploadDir, filename);
    await fs.writeFile(filePath, buffer);
    const url = `${this.publicBaseUrl}/${filename}`;
    this.logger.debug(`Saved upload ${filename}`);
    return { url, path: filePath };
  }

  /** URL đã host sẵn — giữ nguyên */
  normalizeUrl(url: string): string {
    return url.trim();
  }
}
