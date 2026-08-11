import { ShipmentStatus, ShippingFeePayer } from '@prisma/client';
import { VtpAdapter } from '../src/modules/fulfillments/carriers/vtp.adapter';
import type { VtpClient } from '../src/modules/fulfillments/carriers/vtp.client';

function makeAdapter(client: Partial<VtpClient> = {}) {
  return new VtpAdapter(client as VtpClient);
}

describe('VTP-1 map ORDER_STATUS → ShipmentStatus của Sapo', () => {
  const adapter = makeAdapter();

  it('102-104 là pending; 105 (bưu tá đã nhận hàng) là picked_up', () => {
    expect(adapter.mapWebhookStatus('102')).toBe(ShipmentStatus.pending);
    expect(adapter.mapWebhookStatus('103')).toBe(ShipmentStatus.pending);
    expect(adapter.mapWebhookStatus('104')).toBe(ShipmentStatus.pending);
    expect(adapter.mapWebhookStatus('105')).toBe(ShipmentStatus.picked_up);
  });

  it('gộp các chặng khai thác/giao về delivering', () => {
    for (const s of ['300', '400', '500', '508', '550']) {
      expect(adapter.mapWebhookStatus(s)).toBe(ShipmentStatus.delivering);
    }
  });

  it('phân biệt tồn giao (retry_delivery), đang chuyển hoàn (returning) và đã hoàn về kho (returned)', () => {
    for (const s of ['505', '506', '507']) {
      expect(adapter.mapWebhookStatus(s)).toBe(ShipmentStatus.retry_delivery);
    }
    expect(adapter.mapWebhookStatus('502')).toBe(ShipmentStatus.returning);
    expect(adapter.mapWebhookStatus('504')).toBe(ShipmentStatus.returned);
  });

  it('501 delivered; 107/201/503 cancelled', () => {
    expect(adapter.mapWebhookStatus('501')).toBe(ShipmentStatus.delivered);
    for (const s of ['107', '201', '503']) {
      expect(adapter.mapWebhookStatus(s)).toBe(ShipmentStatus.cancelled);
    }
  });

  it('không map bừa mã ranh giới mơ hồ (101 VTP yêu cầu hủy, 200 nhập doanh thu, mã lạ)', () => {
    expect(adapter.mapWebhookStatus('101')).toBeNull();
    expect(adapter.mapWebhookStatus('200')).toBeNull();
    expect(adapter.mapWebhookStatus('999')).toBeNull();
  });
});

describe('VTP-2 báo giá vẫn dùng biểu phí nội bộ', () => {
  it('cộng phụ phí theo từng 500g vượt mức đầu tiên', async () => {
    const services = [
      {
        code: 'standard',
        name: 'Chuẩn',
        eta: '2-4 ngày',
        base_fee: 42000,
        extra_fee_per_500g: 5000,
      },
    ];
    const [q500] = await makeAdapter().quote(services, 500);
    const [q1200] = await makeAdapter().quote(services, 1200);
    expect(q500.fee).toBe(42000);
    expect(q1200.fee).toBe(42000 + 2 * 5000);
  });
});

describe('VTP-3 tạo vận đơn', () => {
  it('login lấy token phiên, chọn dịch vụ rẻ nhất theo mặc định, ORDER_PAYMENT đúng theo feePayer+COD', async () => {
    const client = {
      loginVtp: jest.fn().mockResolvedValue({
        token: 'session-token',
        expired: Date.now() + 60_000,
      }),
      listProvincesNew: jest
        .fn()
        .mockResolvedValue([
          { PROVINCE_ID: 1, PROVINCE_CODE: 'HNI', PROVINCE_NAME: 'Hà Nội' },
        ]),
      getPriceAllNlp: jest.fn().mockResolvedValue([
        {
          MA_DV_CHINH: 'PHS',
          TEN_DICHVU: 'Nội tỉnh tiết kiệm',
          GIA_CUOC: 16500,
          THOI_GIAN: '24 giờ',
        },
        {
          MA_DV_CHINH: 'VCN',
          TEN_DICHVU: 'Chuyển phát nhanh',
          GIA_CUOC: 30000,
          THOI_GIAN: '12 giờ',
        },
      ]),
      createOrderNlp: jest
        .fn()
        .mockResolvedValue({ ORDER_NUMBER: 'VTP123', MONEY_TOTAL: 16500 }),
    };
    const adapter = new VtpAdapter(client as unknown as VtpClient);

    const result = await adapter.createShipment(
      {
        clientOrderCode: 'DH001',
        serviceCode: null,
        toName: 'Nguyen Van A',
        toPhone: '0901234567',
        toAddress: '123 Test',
        toWard: 'Phường 5',
        toDistrict: 'Quận X',
        toProvince: 'Hà Nội',
        originName: 'Kho tổng',
        originPhone: '0987654321',
        originAddress: '39 Cầu Diễn',
        originWard: null,
        originDistrict: null,
        originProvince: null,
        codAmount: 500000,
        insuranceValue: 500000,
        feePayer: ShippingFeePayer.khach_tra,
        weightGrams: 500,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 10,
        deliveryRequirement: null,
        note: null,
        items: [{ name: 'SP', code: null, quantity: 1, price: 500000 }],
      },
      { token: 'secret-token' },
    );

    expect(client.loginVtp).toHaveBeenCalledWith('secret-token');
    expect(result.trackingNumber).toBe('VTP123');
    expect(result.shippingFee).toBe(16500);
    const createPayload = (client.createOrderNlp.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(createPayload.ORDER_SERVICE).toBe('PHS'); // rẻ nhất theo mặc định
    expect(createPayload.ORDER_PAYMENT).toBe(2); // khach_tra + COD>0 -> thu hộ hàng+cước
  });

  it('không tạo được đơn khi thiếu Token kết nối', async () => {
    const adapter = new VtpAdapter({} as VtpClient);
    await expect(
      adapter.createShipment(
        {
          clientOrderCode: 'DH002',
          serviceCode: null,
          toName: 'A',
          toPhone: '0900000000',
          toAddress: 'X',
          toWard: 'W',
          toDistrict: 'D',
          toProvince: 'Hà Nội',
          originName: null,
          originPhone: null,
          originAddress: null,
          originWard: null,
          originDistrict: null,
          originProvince: null,
          codAmount: 0,
          insuranceValue: 0,
          feePayer: ShippingFeePayer.shop_tra,
          weightGrams: 500,
          lengthCm: null,
          widthCm: null,
          heightCm: null,
          deliveryRequirement: null,
          note: null,
          items: [],
        },
        {},
      ),
    ).rejects.toThrow('ViettelPost chưa được kết nối');
  });
});

describe('VTP-4 hủy vận đơn', () => {
  it('gọi UpdateOrder với TYPE=4 và mã vận đơn', async () => {
    const client = {
      loginVtp: jest.fn().mockResolvedValue({
        token: 'session-token',
        expired: Date.now() + 60_000,
      }),
      updateOrder: jest.fn().mockResolvedValue(null),
    };
    const adapter = new VtpAdapter(client as unknown as VtpClient);
    await adapter.cancelShipment('VTP123', { token: 'secret-token' });
    expect(client.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ TYPE: 4, ORDER_NUMBER: 'VTP123' }),
      { token: 'session-token' },
    );
  });
});
