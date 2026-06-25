import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { ConversationService } from './conversation.service';
import {
  CreateConversationDto,
  CreateMessageDto,
  ListConversationsQueryDto,
} from './conversation.dto';

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Get()
  @RequirePermission('order:view')
  list(@Query() query: ListConversationsQueryDto) {
    return this.conversations.list(query);
  }

  @Get(':id')
  @RequirePermission('order:view')
  findOne(@Param('id') id: string) {
    return this.conversations.findOne(BigInt(id));
  }

  @Post()
  @RequirePermission('order:create')
  create(@Body() dto: CreateConversationDto) {
    return this.conversations.create(dto);
  }

  @Post(':id/messages')
  @RequirePermission('order:create')
  addMessage(
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.conversations.addMessage(BigInt(id), dto, user.userId);
  }
}
