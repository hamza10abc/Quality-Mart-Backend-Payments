import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

/**
 * NestJS's default TCP microservice transport discards a thrown exception's
 * actual status/message unless it's specifically an RpcException — any
 * other error (including a plain HttpException like NotFoundException)
 * crosses the wire as a generic `{status:'error', message:'Internal server
 * error'}`, which Gateway's default HTTP filter then renders as a 500
 * regardless of what was actually thrown here.
 *
 * This filter normalizes any exception into `{ response: { statusCode,
 * message }, status }` before it crosses the wire — the shape Gateway's own
 * MicroserviceErrorFilter expects on the other end. Global registration
 * (app.useGlobalFilters / APP_FILTER) does NOT reach @MessagePattern
 * handlers in a hybrid app — this must be applied via @UseFilters() on
 * each controller that has TCP message handlers.
 */
@Catch()
export class MicroserviceExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): Observable<never> | void {
    if (host.getType() === 'rpc') {
      return this.toRpcResponse(exception);
    }

    // Only reached if this filter is ever applied to a controller that also
    // has HTTP routes — none currently do, but kept for safety.
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
    } else {
      response
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ statusCode: 500, message: 'Internal server error' });
    }
  }

  private toRpcResponse(exception: unknown): Observable<never> {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const rawResponse = exception.getResponse();
      const message =
        typeof rawResponse === 'string'
          ? rawResponse
          : ((rawResponse as any)?.message ?? exception.message);
      return throwError(() => ({
        response: { statusCode, message },
        status: statusCode,
      }));
    }
    const message =
      exception instanceof Error ? exception.message : 'Internal server error';
    return throwError(() => ({
      response: { statusCode: 500, message },
      status: 500,
    }));
  }
}
