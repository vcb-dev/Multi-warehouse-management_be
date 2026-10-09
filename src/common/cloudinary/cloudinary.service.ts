import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import { cloudinaryPublicId, imageMime } from './cloudinary';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface StoredImage {
  url: string;
  publicId: string;
}

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private configured = false;

  async uploadImage(
    buffer: Buffer,
    originalName: string,
  ): Promise<StoredImage> {
    if (!buffer?.length) {
      throw new BadRequestException('Thiếu file ảnh');
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Ảnh vượt quá 5MB');
    }
    if (!imageMime(buffer)) {
      throw new BadRequestException('Chỉ nhận ảnh JPEG, PNG, GIF hoặc WebP');
    }
    this.ensureConfigured();

    const folder =
      process.env.CLOUDINARY_FOLDER?.trim().replace(/^\/+|\/+$/g, '') ||
      'OMS_VCB';
    const uploaded = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: 'image', unique_filename: true },
        (error, result) => {
          if (error || !result) {
            reject(error ?? new Error('Cloudinary returned no result'));
            return;
          }
          resolve(result);
        },
      );
      Readable.from(buffer).pipe(stream);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Upload Cloudinary thất bại (${originalName}): ${message}`,
      );
      throw new ServiceUnavailableException('Không lưu được ảnh');
    });

    return { url: uploaded.secure_url, publicId: uploaded.public_id };
  }

  /** Deletes only URLs this app stored. Foreign URLs are left untouched. */
  async deleteByUrl(url: string): Promise<boolean> {
    const publicId = cloudinaryPublicId(url);
    if (!publicId) return false;
    this.ensureConfigured();

    const result = (await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
    })) as { result?: string };

    if (result.result !== 'ok' && result.result !== 'not found') {
      this.logger.error(
        `Xóa Cloudinary thất bại (${publicId}): ${result.result ?? 'unknown'}`,
      );
      throw new ServiceUnavailableException('Không xóa được ảnh');
    }
    return result.result === 'ok';
  }

  private ensureConfigured(): void {
    if (this.configured) return;
    const cloud_name = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const api_key = process.env.CLOUDINARY_API_KEY?.trim();
    const api_secret = process.env.CLOUDINARY_API_SECRET?.trim();
    if (!cloud_name || !api_key || !api_secret) {
      throw new ServiceUnavailableException('Chưa cấu hình Cloudinary');
    }
    cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
    this.configured = true;
  }
}
