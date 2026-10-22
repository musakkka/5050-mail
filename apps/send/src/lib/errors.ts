/** Resend-shaped API errors: `{ statusCode, message, name }`. */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorName: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
  toJSON() {
    return { statusCode: this.statusCode, message: this.message, name: this.errorName };
  }
}

export const E = {
  validation: (message: string, status = 422) => new ApiError(status, 'validation_error', message),
  missingField: (field: string) => new ApiError(422, 'missing_required_field', `Missing \`${field}\` field.`),
  missingFields: (message: string) => new ApiError(422, 'missing_required_field', message),
  invalidParam: (message: string) => new ApiError(422, 'invalid_parameter', message),
  invalidUuid: (param: string) => new ApiError(422, 'invalid_parameter', `The \`${param}\` must be a valid UUID.`),
  notFound: (message: string) => new ApiError(404, 'not_found', message),
  endpointNotFound: () => new ApiError(404, 'not_found', 'The requested endpoint does not exist.'),
  methodNotAllowed: () => new ApiError(405, 'method_not_allowed', 'Method is not allowed for the requested path.'),
  missingApiKey: () => new ApiError(401, 'missing_api_key', 'Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY'),
  invalidApiKey: (status = 400) => new ApiError(status, 'validation_error', 'API key is invalid'),
  restricted: () => new ApiError(401, 'restricted_api_key', 'This API key is restricted to only send emails.'),
  forbidden: (message: string) => new ApiError(403, 'validation_error', message),
  invalidAttachment: (message = 'Attachment must have either a `content` or `path`.') => new ApiError(422, 'invalid_attachment', message),
  invalidFrom: (message: string) => new ApiError(422, 'validation_error', message),
  invalidIdempotencyKey: () => new ApiError(400, 'invalid_idempotency_key', 'Idempotency keys, if present, must have between 1 and 256 characters.'),
  idempotencyMismatch: () =>
    new ApiError(409, 'invalid_idempotent_request', "This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified and doesn't match the original request."),
  idempotencyConcurrent: () => new ApiError(409, 'concurrent_idempotent_requests', 'There is another request in progress with the same idempotency key.'),
  rateLimited: (retryAfter: number) =>
    new ApiError(429, 'rate_limit_exceeded', 'Too many requests. Please limit the number of requests per second. Or contact support to increase rate limit.', { 'retry-after': String(retryAfter) }),
  dailyQuota: () => new ApiError(429, 'daily_quota_exceeded', 'You have exceeded your daily email sending quota.'),
  monthlyQuota: () => new ApiError(429, 'monthly_quota_exceeded', 'You have exceeded your monthly email sending quota.'),
  conflict: (message: string) => new ApiError(409, 'resource_locked', message),
  internal: () => new ApiError(500, 'application_error', 'An unexpected error occurred.'),
};
