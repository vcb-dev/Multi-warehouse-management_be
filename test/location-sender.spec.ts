/**
 * Thông tin người gửi riêng của kho (in trên phiếu giao, gửi sang hãng vận chuyển).
 * Không đụng DB — Prisma giả ghi lại dữ liệu cập nhật.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import { locationSender } from '../src/modules/fulfillments/location-sender';
import { ConfigService } from '../src/modules/config/config.service';
import { UpdateLocationSenderDto } from '../src/modules/config/config.dto';

const LOC = {
  id: 11n,
  name: 'Kho Đồ Da',
  phone: '0966438662',
  senderName: null as string | null,
  senderPhone: null as string | null,
};

describe('locationSender', () => {
  it('có cấu hình người gửi thì dùng tên shop + SĐT riêng', () => {
    expect(
      locationSender({
        ...LOC,
        senderName: 'Shop Thử',
        senderPhone: '1900 1234',
      }),
    ).toEqual({ name: 'Shop Thử', phone: '1900 1234' });
  });

  it('chưa cấu hình (hoặc chỉ toàn dấu cách) thì lùi về tên/SĐT kho như Sapo', () => {
    expect(locationSender(LOC)).toEqual({
      name: 'Kho Đồ Da',
      phone: '0966438662',
    });
    expect(
      locationSender({ ...LOC, senderName: '  ', senderPhone: '' }),
    ).toEqual({ name: 'Kho Đồ Da', phone: '0966438662' });
  });

  it('cấu hình từng trường độc lập', () => {
    expect(locationSender({ ...LOC, senderPhone: '0912000000' })).toEqual({
      name: 'Kho Đồ Da',
      phone: '0912000000',
    });
  });
});

describe('UpdateLocationSenderDto', () => {
  const errorsOf = async (body: object) =>
    (await validate(plainToInstance(UpdateLocationSenderDto, body))).map(
      (e) => e.property,
    );

  it('nhận số hotline có dấu cách / dấu chấm / +84', async () => {
    expect(await errorsOf({ sender_phone: '1900 1234' })).toEqual([]);
    expect(await errorsOf({ sender_phone: '+84 966.438.662' })).toEqual([]);
    expect(await errorsOf({ sender_name: '', sender_phone: '' })).toEqual([]);
  });

  it('từ chối SĐT có chữ cái', async () => {
    expect(await errorsOf({ sender_phone: '0966abc' })).toEqual([
      'sender_phone',
    ]);
  });
});

describe('ConfigService.updateLocationSender', () => {
  function makeService(found = true) {
    const update = jest
      .fn()
      .mockImplementation(({ data }) => ({ ...LOC, sapoId: null, ...data }));
    const prisma = {
      location: {
        findUnique: jest.fn().mockResolvedValue(found ? { id: LOC.id } : null),
        update,
      },
    };
    return { service: new ConfigService(prisma as never), update };
  }

  it('lưu đã cắt khoảng trắng và trả lại sender_* trong kho', async () => {
    const { service, update } = makeService();
    const res = await service.updateLocationSender(LOC.id, {
      sender_name: '  Shop Thử ',
      sender_phone: '1900 1234',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: LOC.id },
      data: { senderName: 'Shop Thử', senderPhone: '1900 1234' },
    });
    expect(res.data).toMatchObject({
      id: '11',
      name: 'Kho Đồ Da',
      sender_name: 'Shop Thử',
      sender_phone: '1900 1234',
    });
  });

  it("bỏ trống = giữ nguyên, '' = xoá về null", async () => {
    const { service, update } = makeService();
    await service.updateLocationSender(LOC.id, { sender_phone: '' });

    expect(update).toHaveBeenCalledWith({
      where: { id: LOC.id },
      data: { senderName: undefined, senderPhone: null },
    });
  });

  it('kho không tồn tại thì 404', async () => {
    const { service, update } = makeService(false);
    await expect(
      service.updateLocationSender(999n, { sender_name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });
});
