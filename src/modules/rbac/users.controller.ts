import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import {
  InviteUserDto,
  ListUsersQueryDto,
  PutWarehouseRolesDto,
  UpdateUserPermissionsDto,
  UpdateUserStatusDto,
} from './rbac.dto';
import { InvitationService } from './invitation.service';
import { UserAdminService } from './user-admin.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private users: UserAdminService,
    private invitations: InvitationService,
  ) {}

  /**
   * Dropdown gán đơn — chỉ id + tên, user active. Dùng ở nhiều module (đơn
   * hàng, nhập hàng, NCC) nên gắn `dashboard:view` — quyền mọi role có sẵn —
   * thay vì `staff:manage`, tránh chặn nhầm nhân viên bình thường.
   */
  @Get('assignable')
  @RequirePermission('dashboard:view')
  listAssignable(@Query('search') search?: string) {
    return this.users.listAssignable(search);
  }

  @Get()
  @RequirePermission('staff:manage')
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermission('staff:manage')
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Post('invite')
  @RequirePermission('staff:manage')
  invite(@Body() dto: InviteUserDto) {
    return this.invitations.invite(dto);
  }

  @Post(':id/resend-invite')
  @RequirePermission('staff:manage')
  resend(@Param('id') id: string) {
    return this.invitations.resend(id);
  }

  @Patch(':id/status')
  @RequirePermission('staff:manage')
  setStatus(@Param('id') id: string, @Body() dto: UpdateUserStatusDto) {
    return this.users.setStatus(id, dto.is_active);
  }

  @Put(':id/warehouse-roles')
  @RequirePermission('staff:manage')
  putWarehouseRoles(
    @Param('id') id: string,
    @Body() dto: PutWarehouseRolesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.users.putWarehouseRoles(id, dto, user);
  }

  @Delete(':id/warehouse-roles/:locationId')
  @RequirePermission('staff:manage')
  @HttpCode(204)
  removeWarehouseRole(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
  ) {
    return this.users.removeWarehouseRole(id, locationId);
  }

  @Get(':id/locations/:locationId/permissions')
  @RequirePermission('staff:manage')
  getWarehousePermissions(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
  ) {
    return this.users.getWarehousePermissions(id, locationId);
  }

  @Put(':id/locations/:locationId/permissions')
  @RequirePermission('staff:manage')
  updateWarehousePermissions(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @Body() dto: UpdateUserPermissionsDto,
  ) {
    return this.users.updateWarehousePermissions(id, locationId, dto);
  }
}
