/**
 * 墨枢 Host 半：带 HTTP 状态码的错误。
 * 路由层统一把 `status` 写进响应码，把 `message` 写进 `{ error }`。
 * `details` 里的字段会原样并入响应体（例如 409 冲突要把磁盘上的 mtime 与全文一起回给前端）。
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码（4xx / 5xx）
   * @param {string} message 中文原因，直接回给前端
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [options]
   */
  constructor(status, message, options) {
    super(message, options)
    this.name = 'HttpError'
    this.status = status
    this.details = options && typeof options.details === 'object' && options.details ? options.details : undefined
  }
}

/** 抛出 HttpError 的简写。 */
export function fail(status, message) {
  throw new HttpError(status, message)
}
