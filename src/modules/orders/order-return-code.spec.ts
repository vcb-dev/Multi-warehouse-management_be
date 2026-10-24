import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderReturnDto } from './order.dto';

const base = { order_id: '1', refund_amount: 0, items: [] };

async function codeErrors(code: unknown) {
  const dto = plainToInstance(CreateOrderReturnDto, { ...base, code });
  const errors = await validate(dto);
  return errors.filter((e) => e.property === 'code');
}

describe('CreateOrderReturnDto.code', () => {
  it('bỏ trống thì hợp lệ (hệ thống tự sinh)', async () => {
    expect(await codeErrors(undefined)).toHaveLength(0);
  });

  it.each(['RTN123', 'RTNABC-1', 'RTN_a.b'])('%s hợp lệ', async (c) => {
    expect(await codeErrors(c)).toHaveLength(0);
  });

  it.each(['ABC123', 'rtn1', 'RTN', 'RTN 1', 'RTN' + 'x'.repeat(30)])(
    '%s bị từ chối',
    async (c) => {
      expect(await codeErrors(c)).toHaveLength(1);
    },
  );
});
