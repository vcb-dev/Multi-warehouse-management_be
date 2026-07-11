import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { CreateCategoryDto } from './category.dto';
import { CategoryService } from './category.service';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private categories: CategoryService) {}

  @Get()
  @RequirePermission('product:view', 'product:manage')
  list() {
    return this.categories.listTree();
  }

  @Post()
  @RequirePermission('product:manage')
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Post(':id/products')
  @RequirePermission('product:manage')
  assignProducts(
    @Param('id') id: string,
    @Body() body: { product_ids: string[] },
  ) {
    return this.categories.assignProducts(
      BigInt(id),
      body.product_ids.map(BigInt),
    );
  }
}
