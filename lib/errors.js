// 应用层错误：携带 HTTP 状态码，RPC 边界把它映射成 {ok:false, error:{status,message}}。
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

// 便捷构造
export const badRequest = (msg) => new AppError(400, msg);
export const unauthorized = (msg = "Invalid or missing credentials") => new AppError(401, msg);
export const forbidden = (msg = "Forbidden") => new AppError(403, msg);
export const notFound = (msg = "Not found") => new AppError(404, msg);
export const conflict = (msg = "Conflict") => new AppError(409, msg);
export const unprocessable = (msg = "Invalid input") => new AppError(422, msg);
export const internal = (msg = "Internal error") => new AppError(500, msg);
export const badGateway = (msg = "Upstream service unavailable") => new AppError(502, msg);
