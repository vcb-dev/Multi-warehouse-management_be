import { orWhenTableMissing } from './report-sql';

/** Lỗi Prisma khi Postgres báo thiếu bảng (`42P01`) — chỉ lỗi này mới được nuốt. */
function pgError(code: string) {
  return Object.assign(new Error('Raw query failed'), { meta: { code } });
}

describe('orWhenTableMissing', () => {
  it('query chạy được thì trả nguyên kết quả, không gọi phương án dự phòng', async () => {
    const fallback = jest.fn();

    await expect(
      orWhenTableMissing(Promise.resolve([1]), fallback),
    ).resolves.toEqual([1]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('thiếu bảng: trả giá trị dự phòng hoặc chạy query thay thế', async () => {
    await expect(
      orWhenTableMissing(Promise.reject(pgError('42P01')), [] as number[]),
    ).resolves.toEqual([]);
    await expect(
      orWhenTableMissing(Promise.reject(pgError('42P01')), () =>
        Promise.resolve([2]),
      ),
    ).resolves.toEqual([2]);
  });

  it('lỗi khác (sai cú pháp, mất kết nối) vẫn ném ra', async () => {
    await expect(
      orWhenTableMissing(Promise.reject(pgError('42601')), []),
    ).rejects.toThrow('Raw query failed');
    await expect(
      orWhenTableMissing(Promise.reject(new Error('boom')), []),
    ).rejects.toThrow('boom');
  });
});
