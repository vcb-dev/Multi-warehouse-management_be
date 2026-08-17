import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListConversationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;
}

export class CreateConversationDto {
  @IsString()
  customer_name!: string;

  @IsString()
  customer_phone!: string;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  @IsString()
  assigned_to?: string;
}

export class CreateMessageDto {
  @IsString()
  body!: string;

  @IsOptional()
  @IsIn(['staff', 'customer'])
  sender_type?: 'staff' | 'customer' = 'staff';
}
