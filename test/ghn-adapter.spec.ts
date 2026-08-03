import { ShipmentStatus } from '@prisma/client';
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
