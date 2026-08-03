import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { CustomerGroupService } from './customer-group.service';
import {
  CreateCustomerGroupDto,
  PreviewCustomerGroupDto,
  SetGroupMembersDto,
  UpdateCustomerGroupDto,
} from './customer.dto';

/** Sapo `customer_groups` — nhóm khách hàng (auto theo rules, hoặc chọn tay). */
@ApiTags('customer-groups')
@ApiBearerAuth()
@Controller('customer-groups')
export class CustomerGroupsController {
  constructor(private groups: CustomerGroupService) {}

  @Get()
  @RequirePermission('customer:view')
  list() {
    return this.groups.list();
  }

  /** Danh mục điều kiện cho builder nhóm tự động — phải khai trước `:id` */
  @Get('rule-options')
  @RequirePermission('customer:view')
  ruleOptions() {
    return this.groups.ruleOptions();
  }

  /** Đếm thử số khách khớp điều kiện, chưa lưu gì */
  @Post('preview')
  @RequirePermission('customer:manage')
  preview(@Body() dto: PreviewCustomerGroupDto) {
    return this.groups.preview(dto);
  }

  @Get(':id')
  @RequirePermission('customer:view')
  findOne(@Param('id') id: string) {
    return this.groups.findOne(BigInt(id));
  }

  @Post()
  @RequirePermission('customer:manage')
  create(@Body() dto: CreateCustomerGroupDto) {
    return this.groups.create(dto);
  }

  @Put(':id')
  @RequirePermission('customer:manage')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerGroupDto) {
    return this.groups.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission('customer:manage')
  remove(@Param('id') id: string) {
    return this.groups.remove(BigInt(id));
  }

  /** Chạy lại điều kiện của nhóm tự động để cập nhật thành viên */
  @Post(':id/recalculate')
  @RequirePermission('customer:manage')
  recalculate(@Param('id') id: string) {
    return this.groups.recalculate(BigInt(id));
  }

  /** Danh sách khách thuộc nhóm (tương ứng /admin/customer_groups/{id}/customers.json) */
  @Get(':id/customers')
  @RequirePermission('customer:view')
  members(
    @Param('id') id: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.groups.members(BigInt(id), Number(page), Number(limit));
  }

  /** Thêm khách vào nhóm (giữ nguyên thành viên cũ) */
  @Post(':id/customers')
  @RequirePermission('customer:manage')
  addMembers(@Param('id') id: string, @Body() dto: SetGroupMembersDto) {
    return this.groups.addMembers(BigInt(id), dto.customer_ids);
  }

  @Delete(':id/customers/:customerId')
  @RequirePermission('customer:manage')
  removeMember(
    @Param('id') id: string,
    @Param('customerId') customerId: string,
  ) {
    return this.groups.removeMember(BigInt(id), BigInt(customerId));
  }
}
