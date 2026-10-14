import { KeyedSerialQueue } from '../src/common/utils/keyed-serial-queue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedSerialQueue', () => {
  it('chạy lần lượt các việc cùng key, đúng thứ tự đưa vào', async () => {
    const queue = new KeyedSerialQueue(() => undefined);
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
    };

    void queue.push('A', task('1', 30));
    void queue.push('A', task('2', 1));
    await queue.push('A', task('3', 1));

    expect(log).toEqual([
      'start 1',
      'end 1',
      'start 2',
      'end 2',
      'start 3',
      'end 3',
    ]);
  });

  it('không bắt key khác phải chờ', async () => {
    const queue = new KeyedSerialQueue(() => undefined);
    const log: string[] = [];
    const slow = queue.push('A', async () => {
      await sleep(40);
      log.push('A');
    });
    await queue.push('B', async () => {
      log.push('B');
    });
    await slow;

    expect(log).toEqual(['B', 'A']);
  });

  it('việc lỗi báo qua onError, việc sau vẫn chạy', async () => {
    const errors: [string, unknown][] = [];
    const queue = new KeyedSerialQueue((key, err) => errors.push([key, err]));
    const boom = new Error('boom');
    let ran = false;

    void queue.push('A', async () => {
      throw boom;
    });
    await queue.push('A', async () => {
      ran = true;
    });

    expect(errors).toEqual([['A', boom]]);
    expect(ran).toBe(true);
  });

  it('dọn key khi hết việc', async () => {
    const queue = new KeyedSerialQueue(() => undefined);
    await queue.push('A', async () => undefined);
    expect(queue.size).toBe(0);
  });
});
