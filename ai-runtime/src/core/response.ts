export interface BaseResponse<T> {
  code: string;
  message: string;
  data: T | null;
}

export function success<T>(data: T, message = "Success"): BaseResponse<T> {
  return {
    code: "success",
    message,
    data,
  };
}

export function error<T = null>(
  code = "internal_error",
  message = "Internal Server Error",
  data: T | null = null,
): BaseResponse<T> {
  return {
    code,
    message,
    data,
  };
}
