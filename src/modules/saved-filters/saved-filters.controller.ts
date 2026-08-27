import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  CreateSavedFilterDto,
  ListSavedFiltersQueryDto,
  UpdateSavedFilterDto,
} from './saved-filter.dto';
import { SavedFilterService } from './saved-filter.service';

/**
 * Bộ lọc lưu sẵn, hiện ra dưới dạng tab ở các màn danh sách.
 *
 * Không gắn quyền theo màn: bộ lọc chỉ là một chuỗi tiêu chí, còn dữ liệu thật
 * vẫn đi qua endpoint của màn tương ứng và chịu đúng phân quyền ở đó.
 */
@ApiTags('saved-filters')
@ApiBearerAuth()
@Controller('saved-filters')
export class SavedFiltersController {
  constructor(private savedFilters: SavedFilterService) {}

  @Get()
  list(
    @Query() query: ListSavedFiltersQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.savedFilters.list(query, user);
  }

  @Post()
  create(@Body() dto: CreateSavedFilterDto, @CurrentUser() user: AuthUser) {
    return this.savedFilters.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSavedFilterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.savedFilters.update(id, dto, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.savedFilters.remove(id, user);
  }
}
