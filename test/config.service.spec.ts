import { BusinessException } from '../src/common/exceptions/business.exception';
import { ConfigService } from '../src/modules/config/config.service';

function prismaStub() {
  const location = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  return {
    location,
    $transaction: jest.fn(async (fn: (tx: { location: typeof location }) => unknown) =>
      fn({ location }),
    ),
  };
}

const row = {
  id: 1n,
  sapoId: null,
  code: 'KHO1',
  name: 'Kho 1',
  status: 'active',
  defaultLocation: false,
  phone: '0901234567',
  email: null,
  address1: null,
  address2: null,
  city: null,
  province: null,
  provinceCode: null,
  district: null,
  districtCode: null,
  ward: null,
  wardCode: null,
  country: null,
  countryCode: null,
  zip: null,
  inventoryManagement: true,
};

describe('ConfigService locations', () => {
  it('createLocation ghi phone', async () => {
    const prisma = prismaStub();
    prisma.location.findFirst.mockResolvedValue(null);
    prisma.location.create.mockResolvedValue(row);
    const svc = new ConfigService(prisma as never);
    const actual = await svc.createLocation({
      name: 'Kho 1',
      phone: '0901234567',
    });
    expect(actual.phone).toBe('0901234567');
    expect(prisma.location.create).toHaveBeenCalled();
  });

  it('createLocation trùng code → 409', async () => {
    const prisma = prismaStub();
    prisma.location.findFirst.mockResolvedValue({ id: 2n });
    const svc = new ConfigService(prisma as never);
    await expect(
      svc.createLocation({ name: 'X', code: 'KHO1' }),
    ).rejects.toMatchObject({ code: 'CODE_EXISTS', statusCode: 409 });
  });

  it('deactivateLocation đặt inactive', async () => {
    const prisma = prismaStub();
    prisma.location.findUnique.mockResolvedValue(row);
    prisma.location.findFirst.mockResolvedValue(null);
    prisma.location.update.mockResolvedValue({ ...row, status: 'inactive' });
    const svc = new ConfigService(prisma as never);
    const actual = await svc.deactivateLocation(1n);
    expect(actual.status).toBe('inactive');
  });

  it('updateLocation xóa code khi nhận null', async () => {
    const prisma = prismaStub();
    prisma.location.findUnique.mockResolvedValue(row);
    prisma.location.findFirst.mockResolvedValue(null);
    prisma.location.update.mockResolvedValue({ ...row, code: null });
    const svc = new ConfigService(prisma as never);
    const actual = await svc.updateLocation(1n, { code: null });
    expect(actual.code).toBeNull();
    expect(prisma.location.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: null }) }),
    );
  });

  it('updateLocation 404 khi không có kho', async () => {
    const prisma = prismaStub();
    prisma.location.findUnique.mockResolvedValue(null);
    const svc = new ConfigService(prisma as never);
    await expect(
      svc.updateLocation(9n, { phone: '0901111111' }),
    ).rejects.toBeInstanceOf(BusinessException);
  });
});
