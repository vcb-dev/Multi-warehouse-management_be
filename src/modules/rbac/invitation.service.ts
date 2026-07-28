import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { InviteUserDto } from './rbac.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

@Injectable()
export class InvitationService {
  constructor(private prisma: PrismaService) {}

  private hashToken(token: string) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private buildInviteLink(token: string) {
    const base = process.env.APP_PUBLIC_URL ?? 'http://localhost:3002';
    return `${base}/kich-hoat?token=${token}`;
  }

  private async issueToken(userId: bigint) {
    const token = crypto.randomBytes(32).toString('hex');
    await this.prisma.userInvitation.updateMany({
      where: { userId, acceptedAt: null },
      data: { expiresAt: new Date() },
    });
    await this.prisma.userInvitation.create({
      data: {
        userId,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    return token;
  }

  async invite(dto: InviteUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('EMAIL_EXISTS');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.first_name,
        lastName: dto.last_name,
        phoneNumber: dto.phone,
        passwordHash: null,
        status: 'invited',
        active: false,
        roles: [],
      },
    });
    const token = await this.issueToken(user.id);
    const result: {
      data: { id: string; email: string; status: string };
      invite_link?: string;
    } = {
      data: { id: user.id.toString(), email: user.email, status: user.status },
    };
    if (process.env.INVITE_RETURN_LINK === 'true') {
      result.invite_link = this.buildInviteLink(token);
    }
    return result;
  }

  async resend(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: BigInt(userId) } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    if (user.status === 'active') throw new ConflictException('ALREADY_ACTIVE');
    const token = await this.issueToken(user.id);
    const out: { data: { resent: true }; invite_link?: string } = {
      data: { resent: true },
    };
    if (process.env.INVITE_RETURN_LINK === 'true') {
      out.invite_link = this.buildInviteLink(token);
    }
    return out;
  }

  private async findValidInvitation(token: string) {
    const invitation = await this.prisma.userInvitation.findFirst({
      where: { tokenHash: this.hashToken(token), acceptedAt: null },
      include: { user: true },
    });
    if (!invitation) throw new NotFoundException('INVITE_NOT_FOUND');
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new GoneException('INVITE_EXPIRED');
    }
    return invitation;
  }

  async checkToken(token: string) {
    const invitation = await this.findValidInvitation(token);
    return { data: { email: invitation.user.email, valid: true } };
  }

  async accept(token: string, password: string) {
    const invitation = await this.findValidInvitation(token);
    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: invitation.userId },
        data: { passwordHash, status: 'active', active: true },
      }),
      this.prisma.userInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      }),
    ]);
    return { data: { activated: true } };
  }
}
