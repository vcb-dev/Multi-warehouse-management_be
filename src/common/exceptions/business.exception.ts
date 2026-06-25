export class BusinessException extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'BusinessException';
  }
}

export class InsufficientStockException extends BusinessException {
  constructor(message = 'Không đủ tồn available') {
    super('INSUFFICIENT_STOCK', message, 409);
  }
}
