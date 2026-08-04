import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { CreateApiKeyDto } from './api-key.dto';
import { ApiKeyService } from './api-key.service';

/** Quản lý API key cấp cho đối tác bên thứ 3 — JWT nội bộ, chỉ admin/được cấp quyền mới gọi. */
@ApiTags('api-keys')
@ApiBearerAuth()
@Controller('api-keys')
export class ApiKeyController {
  constructor(private apiKeys: ApiKeyService) {}

  /** Trả `api_key` (raw) đúng MỘT lần — lưu lại ngay, không xem lại được. */
  @Post()
  @RequirePermission('api_key:manage')
  create(@Body() dto: CreateApiKeyDto, @CurrentUser() user: AuthUser) {
    return this.apiKeys.create(dto, user);
  }

  @Get()
  @RequirePermission('api_key:manage')
  list() {
    return this.apiKeys.list();
  }

  @Delete(':id')
  @RequirePermission('api_key:manage')
  revoke(@Param('id') id: string) {
    return this.apiKeys.revoke(id);
  }
}
