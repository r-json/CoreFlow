import { NextResponse } from 'next/server';

export interface StandardApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export class ApiResponse {
  static success<T>(data: T, status = 200): NextResponse<StandardApiResponse<T>> {
    return NextResponse.json(
      {
        success: true,
        data,
      },
      { status }
    );
  }

  static error(message: string, status = 400): NextResponse<StandardApiResponse<null>> {
    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status }
    );
  }

  static unauthorized(message = 'Unauthorized'): NextResponse<StandardApiResponse<null>> {
    return ApiResponse.error(message, 401);
  }

  static forbidden(message = 'Forbidden'): NextResponse<StandardApiResponse<null>> {
    return ApiResponse.error(message, 403);
  }

  static notFound(message = 'Resource not found'): NextResponse<StandardApiResponse<null>> {
    return ApiResponse.error(message, 404);
  }

  static serverError(message = 'Internal server error'): NextResponse<StandardApiResponse<null>> {
    return ApiResponse.error(message, 500);
  }
}
