/** Safe telemetry for SDK callback envelopes ({error}), RetryError.errors and
 * nested causes. Never serialize prompts, headers, URLs or response bodies. */
export function providerErrorSummary(input: unknown) {
  const rows: Record<string, unknown>[] = []
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value) || rows.length >= 20) return
    seen.add(value)
    const row = value as Record<string, unknown>
    rows.push(row)
    for (const key of ["error", "cause", "lastError", "data"]) visit(row[key], depth + 1)
    if (Array.isArray(row.errors)) row.errors.slice(-3).forEach((error) => visit(error, depth + 1))
    if (typeof row.responseBody === "string" && row.responseBody.length <= 16384) {
      try {
        visit(JSON.parse(row.responseBody), depth + 1)
      } catch {
        /* Non-JSON bodies stay private. */
      }
    }
  }
  visit(input, 0)
  const statusCode = rows
    .map((row) => row.statusCode ?? row.status)
    .find(
      (value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599,
    )
  const token = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : undefined
  const code = rows
    .map(
      (row) =>
        token(row.code) || (typeof row.code === "number" && Number.isFinite(row.code) ? String(row.code) : undefined),
    )
    .find(Boolean)
  const name = rows.map((row) => token(row.name) || token(row.type)).find(Boolean)
  const requestId = rows
    .flatMap((row) => {
      const headers = row.responseHeaders
      const header = (key: string) =>
        headers instanceof Headers
          ? headers.get(key)
          : headers && typeof headers === "object"
            ? Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1]
            : undefined
      return [
        row.requestId,
        row.request_id,
        row.traceId,
        row.trace_id,
        header("x-request-id"),
        header("x-trace-id"),
        header("request-id"),
      ].map(token)
    })
    .find(Boolean)
  // Error messages can contain echoed user content or credentials. Emit a
  // classified explanation, not a substring of an untrusted response body.
  const descriptions = [
    typeof input === "string" ? input : "",
    ...rows.map((row) => (typeof row.message === "string" ? row.message : "")),
  ].join(" ")
  const classification = [code, ...rows.map((row) => token(row.type)), descriptions].filter(Boolean).join(" ")
  const category =
    statusCode === 413 || /context_length_exceeded|request.*too large|read body failed/i.test(classification)
      ? "request_too_large"
      : statusCode === 429 || /rate.?limit|too many requests/i.test(classification)
        ? "rate_limited"
        : statusCode === 401 || statusCode === 403 || /authentication_error|permission_error/.test(classification)
          ? "authentication_or_permission"
          : statusCode && statusCode >= 500
            ? "upstream_unavailable"
            : /timeout|timed out/i.test(descriptions)
              ? "timeout"
              : /fetch failed|connection|socket|ECONN|ENOTFOUND/i.test(descriptions)
                ? "network_error"
                : "provider_error"
  const body = rows.find((row) => row.requestBodyValues !== undefined)?.requestBodyValues
  const bytes = (() => {
    if (body === undefined) return undefined
    try {
      return Buffer.byteLength(JSON.stringify(body), "utf8")
    } catch {
      return undefined
    }
  })()
  return {
    name,
    code,
    statusCode,
    requestId,
    category,
    message:
      "Model request failed: " + category + (statusCode ? " (HTTP " + statusCode + ")" : " (HTTP status unavailable)"),
    isRetryable: rows.map((row) => row.isRetryable).find((value): value is boolean => typeof value === "boolean"),
    requestBodyBytes: bytes,
  }
}

/** Request composition only; no text, image bytes or tool arguments in logs. */
export function providerRequestSummary(prompt: unknown) {
  const messages = Array.isArray(prompt) ? prompt : []
  let imageCount = 0
  let imageBytes = 0
  let textBytes = 0
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || !value || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
      return
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1))
      return
    }
    const row = value as Record<string, unknown>
    if (
      row.type === "image" ||
      row.type === "image-data" ||
      row.type === "image-url" ||
      (row.type === "media" && typeof row.mediaType === "string" && row.mediaType.startsWith("image/"))
    ) {
      imageCount++
      const data = row.image ?? row.data ?? row.url
      imageBytes +=
        typeof data === "string"
          ? Buffer.byteLength(data, "utf8")
          : data instanceof Uint8Array
            ? Math.ceil(data.byteLength / 3) * 4
            : 0
    }
    if (typeof row.text === "string") textBytes += Buffer.byteLength(row.text, "utf8")
    for (const [key, child] of Object.entries(row)) {
      if (key !== "image" && key !== "data") visit(child, depth + 1)
    }
  }
  visit(messages, 0)
  return { messageCount: messages.length, imageCount, imageBytes, textBytes }
}
