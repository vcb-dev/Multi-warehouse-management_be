import { ShipmentStatus } from '@prisma/client';
import { BusinessException } from '../src/common/exceptions/business.exception';
import { GhnLocationResolver } from '../src/modules/fulfillments/carriers/ghn-location-resolver';
import { GhnAdapter } from '../src/modules/fulfillments/carriers/ghn.adapter';
import type { GhnClient } from '../src/modules/fulfillments/carriers/ghn.client';

function makeAdapter(client: Partial<GhnClient> = {}) {
  const c = client as GhnClient;
  return new GhnAdapter(c, new GhnLocationResolver(c));
}

describe('GHN-1 map trạng thái GHN → ShipmentStatus của Sapo', () => {
  const adapter = makeAdapter();

  it('trừ tồn kho đúng lúc GHN đã lấy hàng, không phải lúc mới tạo đơn', () => {
    // ready_to_pick/picking là "chờ lấy" — chưa được trừ tồn
    expect(adapter.mapWebhookStatus('ready_to_pick')).toBe(
      ShipmentStatus.pending,
    );
    expect(adapter.mapWebhookStatus('picking')).toBe(ShipmentStatus.pending);
    expect(adapter.mapWebhookStatus('money_collect_picking')).toBe(
      ShipmentStatus.pending,
    );
    // picked = shipper đã cầm hàng → điểm trừ on_hand
    expect(adapter.mapWebhookStatus('picked')).toBe(ShipmentStatus.picked_up);
  });

  it('gộp các chặng trung chuyển của GHN về delivering', () => {
    for (const s of [
      'storing',
      'transporting',
      'sorting',
      'delivering',
      'money_collect_delivering',
    ]) {
      expect(adapter.mapWebhookStatus(s)).toBe(ShipmentStatus.delivering);
    }
  });

  it('phân biệt đang chuyển hoàn (chưa nhập kho) với đã hoàn về kho', () => {
    for (const s of [
      'return',
      'return_transporting',
      'return_sorting',
      'returning',
      'return_fail',
    ]) {
      expect(adapter.mapWebhookStatus(s)).toBe(ShipmentStatus.returning);
    }
    // Chỉ `returned` mới nhập lại on_hand
    expect(adapter.mapWebhookStatus('returned')).toBe(ShipmentStatus.returned);
  });

  it('giao lỗi và chờ hoàn đều là retry_delivery', () => {
    expect(adapter.mapWebhookStatus('delivery_fail')).toBe(
      ShipmentStatus.retry_delivery,
    );
    expect(adapter.mapWebhookStatus('waiting_to_return')).toBe(
      ShipmentStatus.retry_delivery,
    );
  });

  it('delivered/cancel là trạng thái kết thúc', () => {
    expect(adapter.mapWebhookStatus('delivered')).toBe(
      ShipmentStatus.delivered,
    );
    expect(adapter.mapWebhookStatus('cancel')).toBe(ShipmentStatus.cancelled);
  });

  it('không map bừa damage/lost/exception — sai sẽ làm lệch tồn kho', () => {
    expect(adapter.mapWebhookStatus('damage')).toBeNull();
    expect(adapter.mapWebhookStatus('lost')).toBeNull();
    expect(adapter.mapWebhookStatus('exception')).toBeNull();
    expect(adapter.mapWebhookStatus('trang_thai_moi_cua_ghn')).toBeNull();
  });
});

describe('GHN-2 báo giá vẫn dùng biểu phí nội bộ', () => {
  it('cộng phụ phí theo từng 500g vượt mức đầu tiên', async () => {
    const services = [
      {
        code: 'standard',
        name: 'Chuẩn',
        eta: '2-3 ngày',
        base_fee: 44080,
        extra_fee_per_500g: 5500,
      },
    ];
    const [q500] = await makeAdapter().quote(services, 500);
    const [q1200] = await makeAdapter().quote(services, 1200);
    expect(q500.fee).toBe(44080);
    // 1200g → 3 mức 500g → 2 mức phụ phí
    expect(q1200.fee).toBe(44080 + 2 * 5500);
  });
});

describe('GHN-3 tạo vận đơn — payload create', () => {
  it('gửi to_* theo tên GHN; không gửi from_* (ShopId); sandbox retry HCM', async () => {
    const prevEnv = process.env.GHN_ENV;
    process.env.GHN_ENV = 'sandbox';
    let attempt = 0;
    let captured: Record<string, unknown> | undefined;
    const client = {
      getShops: jest.fn().mockResolvedValue([
        {
          _id: 208660,
          name: 'Kho test',
          phone: '0964794541',
          address: '39 Cầu Diễn',
          district_id: 1482,
          ward_code: '11007',
        },
      ]),
      getAvailableServices: jest
        .fn()
        .mockResolvedValue([
          { service_id: 53320, short_name: 'Chuẩn', service_type_id: 2 },
        ]),
      createOrder: jest.fn(async (payload) => {
        attempt++;
        captured = payload as Record<string, unknown>;
        if (attempt === 1) {
          throw new BusinessException(
            'CARRIER_ERROR',
            'GHN: SERVER_ERR_COMMON — Lỗi hệ thống - không lấy được thông tin kho',
            422,
          );
        }
        return { order_code: 'GHN123', total_fee: 44080 };
      }),
      getWards: jest
        .fn()
        .mockResolvedValue([
          { WardCode: '11007', WardName: 'Phường Phú Diễn' },
        ]),
      getProvinces: jest
        .fn()
        .mockResolvedValue([{ ProvinceID: 201, ProvinceName: 'Hà Nội' }]),
      getDistricts: jest
        .fn()
        .mockResolvedValue([
          { DistrictID: 1482, DistrictName: 'Quận Bắc Từ Liêm' },
        ]),
    };
    const resolver = new GhnLocationResolver(client as unknown as GhnClient);
    jest.spyOn(resolver, 'resolve').mockResolvedValue({
      districtId: 1556,
      wardCode: '530106',
      provinceName: 'Tiền Giang',
      districtName: 'Thành phố Mỹ Tho',
      wardName: 'Phường 5',
    });
    const adapter = new GhnAdapter(client as unknown as GhnClient, resolver);

    await adapter.createShipment(
      {
        clientOrderCode: 'DH001',
        serviceCode: 'standard',
        toName: 'Nguyen Van A',
        toPhone: '0901234567',
        toAddress: '123 Test',
        toWard: 'Phường 5',
        toDistrict: 'Thành phố Mỹ Tho',
        toProvince: 'Tiền Giang',
        originName: 'Kho Sapo',
        originPhone: '0987654321',
        originAddress: '39 Cầu Diễn',
        originWard: null,
        originDistrict: null,
        originProvince: null,
        codAmount: 0,
        insuranceValue: 100000,
        feePayer: 'shop_tra' as const,
        weightGrams: 500,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 10,
        deliveryRequirement: null,
        note: null,
        items: [{ name: 'SP', code: null, quantity: 1, price: 100000 }],
      },
      {
        token: 't',
        shop_id: '208660',
      },
    );

    expect(captured).toBeDefined();
    expect(captured?.from_name).toBeUndefined();
    expect(captured?.from_ward_name).toBe('Phường 14');
    expect(captured?.from_district_name).toBe('Quận 10');
    expect(captured?.from_province_name).toBe('HCM');
    expect(captured?.to_ward_name).toBe('Phường 5');
    expect(client.createOrder).toHaveBeenCalledTimes(2);
    process.env.GHN_ENV = prevEnv;
  });
});
