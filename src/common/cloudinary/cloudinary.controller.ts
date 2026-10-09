import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import {
  LocationOptional,
  RequirePermission,
} from '../decorators/permissions.decorator';
import { CloudinaryService } from './cloudinary.service';

class DeleteCloudinaryImageDto {
  @IsString()
  url!: string;
}

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('cloudinary')
export class CloudinaryController {
  constructor(private readonly cloudinary: CloudinaryService) {}

  @Post('image')
  @RequirePermission('product:manage')
  @LocationOptional()
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @UploadedFile()
    file: { buffer?: Buffer; originalname?: string } | undefined,
  ): Promise<{ url: string }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Thiếu file ảnh');
    }
    const saved = await this.cloudinary.uploadImage(
      file.buffer,
      file.originalname ?? 'image',
    );
    return { url: saved.url };
  }

  @Delete('image')
  @RequirePermission('product:manage')
  @LocationOptional()
  @HttpCode(200)
  async deleteImage(@Body() dto: DeleteCloudinaryImageDto) {
    try {
      const deleted = await this.cloudinary.deleteByUrl(dto.url);
      return { deleted, ok: true };
    } catch {
      return { deleted: false, ok: false };
    }
  }
}
