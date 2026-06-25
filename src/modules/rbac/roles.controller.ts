import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { CreateRoleDto, UpdateRoleDto } from './rbac.dto';
import { RoleService } from './role.service';

@ApiTags('rbac')
@ApiBearerAuth()
@Controller('roles')
@RequirePermission('role:manage')
export class RolesController {
  constructor(private roles: RoleService) {}

  @Get()
  list() {
    return this.roles.list();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.roles.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateRoleDto) {
    return this.roles.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.roles.remove(id);
  }
}
