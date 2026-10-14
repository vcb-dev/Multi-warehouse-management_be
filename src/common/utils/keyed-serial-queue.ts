/**
 * Hàng đợi trong tiến trình: việc cùng `key` chạy lần lượt theo thứ tự đưa vào, việc khác
 * `key` chạy song song. Dùng cho webhook phải trả lời hãng ngay rồi mới xử lý — hai hành
 * trình của cùng một vận đơn không được chạy chồng lên nhau (mỗi bước đụng tồn kho).
 *
 * Chỉ nằm trong bộ nhớ: tiến trình chết giữa chừng là mất việc đang chờ.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly onError: (key: string, err: unknown) => void) {}

  /** Không bao giờ ném: lỗi của `task` đi vào `onError`, việc xếp sau vẫn chạy. */
  push(key: string, task: () => Promise<unknown>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev
      .then(task)
      .then(
        () => undefined,
        (err) => this.onError(key, err),
      )
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    this.tails.set(key, next);
    return next;
  }

  get size(): number {
    return this.tails.size;
  }
}
