import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { BusinessException } from '../exceptions/business.exception';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (exception instanceof BusinessException) {
      return res.status(exception.statusCode).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.fields ? { fields: exception.fields } : {}),
        },
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? 'Error');
      const fields =
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        Array.isArray((body as { message?: unknown }).message)
          ? { _root: (body as { message: string[] }).message }
          : undefined;

      return res.status(status).json({
        error: {
          code: status === HttpStatus.UNPROCESSABLE_ENTITY ? 'VALIDATION_ERROR' : 'HTTP_ERROR',
          message: Array.isArray(message) ? message.join(', ') : message,
          ...(fields ? { fields } : {}),
        },
      });
    }

    console.error(exception);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' },
    });
  }
}
