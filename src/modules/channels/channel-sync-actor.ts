import { UserRole } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';

const ACTOR_SELECT = { id: true, email: true, roles: true } as const;
type ActorRow = { id: bigint; email: string; roles: UserRole[] };

/**
 * User cho cron/webhook kênh — không có JWT nên phải chọn một tài khoản hệ thống.
 *
 * Thứ tự ưu tiên:
 * 1. `CHANNEL_SYNC_ACTOR_USER_ID`
 * 2. `CHANNEL_SYNC_ACTOR_EMAIL`
 * 3. `admin@local.dev` (seed dev, nếu còn active)
 * 4. admin active đầu tiên trong DB
 */
export async function resolveChannelSyncActorUser(
  prisma: PrismaService,
): Promise<ActorRow | null> {
  const envId = process.env.CHANNEL_SYNC_ACTOR_USER_ID?.trim();
  if (envId) {
    const byId = await prisma.user.findFirst({
      where: { id: BigInt(envId), active: true },
      select: ACTOR_SELECT,
    });
    if (byId) return byId;
  }

  const envEmail = process.env.CHANNEL_SYNC_ACTOR_EMAIL?.trim();
  if (envEmail) {
    const byEmail = await prisma.user.findFirst({
      where: { email: envEmail, active: true },
      select: ACTOR_SELECT,
    });
    if (byEmail) return byEmail;
  }

  const seeded = await prisma.user.findFirst({
    where: { email: 'admin@vcb.com', active: true },
    select: ACTOR_SELECT,
  });
  if (seeded) return seeded;

  return prisma.user.findFirst({
    where: { active: true, roles: { has: UserRole.admin } },
    orderBy: { id: 'asc' },
    select: ACTOR_SELECT,
  });
}

export async function resolveChannelSyncActorId(
  prisma: PrismaService,
): Promise<bigint | null> {
  const user = await resolveChannelSyncActorUser(prisma);
  return user?.id ?? null;
}

/** Full AuthUser + RBAC — dùng khi đi qua OrderService / kiểm tra quyền kho. */
export async function resolveChannelSyncActor(
  prisma: PrismaService,
  rbac: RbacService,
): Promise<AuthUser | null> {
  const user = await resolveChannelSyncActorUser(prisma);
  if (!user) return null;
  return toAuthUser(user, rbac);
}

async function toAuthUser(
  user: ActorRow,
  rbac: RbacService,
): Promise<AuthUser> {
  const resolved = await rbac.resolvePermissions(user.id);
  return {
    userId: user.id,
    email: user.email,
    roles: user.roles,
    locationIds: resolved.locationIds,
    isAdmin: resolved.isAdmin,
    adminWarehouseIds: resolved.adminWarehouseIds,
    systemPermissions: resolved.systemPermissions,
    permissions: resolved.systemPermissions,
    warehousePermissions: resolved.warehousePermissions,
  };
}
