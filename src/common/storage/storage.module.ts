import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { UploadController } from './upload.controller';

@Global()
@Module({
  controllers: [UploadController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
