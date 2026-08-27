import { Module } from '@nestjs/common';
import { SavedFilterService } from './saved-filter.service';
import { SavedFiltersController } from './saved-filters.controller';

@Module({
  controllers: [SavedFiltersController],
  providers: [SavedFilterService],
  exports: [SavedFilterService],
})
export class SavedFiltersModule {}
