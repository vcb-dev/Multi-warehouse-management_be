import { Injectable, PipeTransform } from '@nestjs/common';
import { BusinessException } from '../exceptions/business.exception';

/** Đổi param dạng chuỗi sang BigInt. BigInt('abc') ném SyntaxError và bị filter
 * dịch thành 500 "Lỗi hệ thống"; pipe này trả 400 rõ nghĩa thay vào đó. */
@Injectable()
export class ParseBigIntPipe implements PipeTransform<string, bigint> {
  transform(value: string): bigint {
    if (!/^\d+$/.test(value ?? '')) {
      throw new BusinessException(
        'INVALID_ID',
        `ID không hợp lệ: ${value}`,
        400,
      );
    }
    return BigInt(value);
  }
}
