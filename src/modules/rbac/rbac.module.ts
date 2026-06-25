import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RbacService } from './rbac.service';
import { RoleService } from './role.service';
import { InvitationService } from './invitation.service';
import { UserAdminService } from './user-admin.service';
import { RolesController } from './roles.controller';
import { PermissionsController } from './permissions.controller';
import { UsersController } from './users.controller';

@Module({
  imports: [PrismaModule],
  controllers: [RolesController, PermissionsController, UsersController],
  providers: [RbacService, RoleService, InvitationService, UserAdminService],
  exports: [RbacService, InvitationService],
})
export class RbacModule {}
