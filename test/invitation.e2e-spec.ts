/**
 * E2E luồng mời → kích hoạt → đăng nhập.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/invitation.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { GoneException, NotFoundException } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RbacModule } from '../src/modules/rbac/rbac.module';
import { InvitationService } from '../src/modules/rbac/invitation.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('invitation flow (integration)', () => {
  let invitations: InvitationService;
  let auth: AuthService;
  let prisma: PrismaService;

  const testEmail = `invite-test-${Date.now()}@local.dev`;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    process.env.INVITE_RETURN_LINK = 'true';
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RbacModule,
        JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
      ],
      providers: [AuthService],
    }).compile();
    invitations = module.get(InvitationService);
    auth = module.get(AuthService);
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    if (userId) {
      await prisma.userInvitation.deleteMany({ where: { userId: BigInt(userId) } });
      await prisma.userLocationRole.deleteMany({ where: { userId: BigInt(userId) } });
      await prisma.user.deleteMany({ where: { id: BigInt(userId) } });
    }
    await prisma.$disconnect();
  });

  it('mời user mới → trả invite_link', async () => {
    const res = await invitations.invite({
      last_name: 'Test Invite',
      email: testEmail,
    });
    userId = res.data.id;
    expect(res.data.status).toBe('invited');
    expect(res.invite_link).toBeDefined();
    const match = res.invite_link!.match(/token=([a-f0-9]+)/);
    expect(match).toBeTruthy();
    token = match![1];
  });

  it('checkToken trả email hợp lệ', async () => {
    const res = await invitations.checkToken(token);
    expect(res.data.valid).toBe(true);
    expect(res.data.email).toBe(testEmail);
  });

  it('resend vô hiệu token cũ', async () => {
    const oldToken = token;
    const res = await invitations.resend(userId);
    expect(res.invite_link).toBeDefined();
    const match = res.invite_link!.match(/token=([a-f0-9]+)/);
    token = match![1];
    await expect(invitations.checkToken(oldToken)).rejects.toBeInstanceOf(GoneException);
  });

  it('accept → kích hoạt và cho phép login', async () => {
    await invitations.accept(token, 'secret123');
    const login = await auth.login(testEmail, 'secret123');
    expect(login.access_token).toBeDefined();
    expect(login.user.email).toBe(testEmail);
    expect(login.user.is_admin).toBe(false);
  });

  it('token đã dùng không accept lại', async () => {
    await expect(invitations.accept(token, 'secret123')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
