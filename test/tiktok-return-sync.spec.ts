/**
 * Gộp phiếu hoàn TikTok → cặp `return_status` / `refund_status` của đơn.
 * Chạy: npm test -- test/tiktok-return-sync.spec.ts
 *
 * Trạng thái và tỉ lệ dưới đây lấy từ 563 phiếu thật (đo 2026-08-18), không phải từ
 * tài liệu — đây là chỗ đoán sai sẽ báo hoàn tiền cho đơn khách vẫn đang giữ hàng.
 */
import { Prisma } from '@prisma/client';
import { summarizeReturns } from '../src/modules/channels/tiktok/tiktok-return-sync.service';
import type { TiktokReturn } from '../src/modules/channels/tiktok/tiktok-api.client';

const d = (v: string) => new Prisma.Decimal(v);
const ret = (r: Partial<TiktokReturn>): TiktokReturn =>
  ({
    return_id: '4041859431151994424',
    order_id: '585362242944009784',
    return_type: 'RETURN_AND_REFUND',
    ...r,
  }) as TiktokReturn;

describe('summarizeReturns', () => {
  it('phiếu hoàn tất, hoàn đủ tiền', () => {
    expect(
      summarizeReturns(
        [ret({ return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', refund_amount: { refund_total: '720900' } })],
        d('720900'),
      ),
    ).toEqual({ returnStatus: 'returned', refundStatus: 'refunded' });
  });

  it('yêu cầu bị huỷ KHÔNG phải là đã hoàn', () => {
    // 96/563 phiếu ở trạng thái này — coi là "xong" sẽ báo hoàn cho gần 1/6 số phiếu
    expect(
      summarizeReturns(
        [ret({ return_status: 'RETURN_OR_REFUND_REQUEST_CANCEL', refund_amount: { refund_total: '720900' } })],
        d('720900'),
      ),
    ).toEqual({ returnStatus: 'no_return', refundStatus: 'no_refund' });
  });

  it('hàng đang trên đường về thì đơn vẫn đang xử lý', () => {
    expect(
      summarizeReturns([ret({ return_status: 'BUYER_SHIPPED_ITEM' })], d('720900')),
    ).toEqual({ returnStatus: 'in_progress', refundStatus: 'no_refund' });
    expect(
      summarizeReturns([ret({ return_status: 'AWAITING_BUYER_SHIP' })], d('720900')),
    ).toEqual({ returnStatus: 'in_progress', refundStatus: 'no_refund' });
  });

  it('trạng thái lạ thì coi là đang xử lý, không coi là đã hoàn', () => {
    // Đoán nhầm thành "đã hoàn" là báo sai tiền; nhầm thành "đang xử lý" chỉ chốt muộn
    expect(
      summarizeReturns([ret({ return_status: 'MOT_TRANG_THAI_MOI_CUA_TIKTOK' })], d('100')),
    ).toEqual({ returnStatus: 'in_progress', refundStatus: 'no_refund' });
  });

  it('một phiếu xong + một phiếu đang mở thì đơn vẫn đang xử lý', () => {
    expect(
      summarizeReturns(
        [
          ret({ return_id: '1', return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', refund_amount: { refund_total: '300000' } }),
          ret({ return_id: '2', return_status: 'BUYER_SHIPPED_ITEM' }),
        ],
        d('720900'),
      ).returnStatus,
    ).toBe('in_progress');
  });

  it('nhiều phiếu hoàn từng phần thì cộng dồn tiền', () => {
    const r = summarizeReturns(
      [
        ret({ return_id: '1', return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', refund_amount: { refund_total: '300000' } }),
        ret({ return_id: '2', return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', refund_amount: { refund_total: '420900' } }),
      ],
      d('720900'),
    );
    expect(r).toEqual({ returnStatus: 'returned', refundStatus: 'refunded' });
  });

  it('hoàn ít hơn tiền đơn là hoàn một phần', () => {
    expect(
      summarizeReturns(
        [ret({ return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', refund_amount: { refund_total: '300000' } })],
        d('720900'),
      ).refundStatus,
    ).toBe('partial');
  });

  it('hoàn vượt tiền đơn (kèm phí ship) vẫn là hoàn đủ', () => {
    expect(
      summarizeReturns(
        [ret({ return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', refund_amount: { refund_total: '760900' } })],
        d('720900'),
      ).refundStatus,
    ).toBe('refunded');
  });

  it('REFUND (hoàn tiền không trả hàng) không được đánh dấu đã trả hàng', () => {
    // 3/563 phiếu — không có hàng nào về kho nên return_status phải là no_return
    expect(
      summarizeReturns(
        [ret({ return_type: 'REFUND', return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', refund_amount: { refund_total: '720900' } })],
        d('720900'),
      ),
    ).toEqual({ returnStatus: 'no_return', refundStatus: 'refunded' });
  });
});
