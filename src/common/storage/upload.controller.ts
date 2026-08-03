import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  LocationOptional,
  RequirePermission,
} from '../decorators/permissions.decorator';
import { StorageService } from './storage.service';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadController {
  constructor(private storage: StorageService) {}

  @Post('image')
  @RequirePermission('product:manage')
  @LocationOptional()
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
  ) {
    if (!file?.buffer) {
      return { url: null, error: 'Thiếu file' };
    }
    const saved = await this.storage.saveImage(file.buffer, file.originalname);
    return { url: saved.url };
  }
}
