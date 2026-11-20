import { describe, expect, test } from "bun:test"
import { providerErrorSummary, providerRequestSummary } from "../../src/provider/error-summary"

describe("provider error diagnostics", () => {
  test("unwraps the AI SDK onError envelope without leaking request or response contents", () => {
    const result = providerErrorSummary({
      error: {
        name: "AI_APICallError",
        message: "secret business content",
        statusCode: 413,
        responseHeaders: { "X-Request-ID": "trace-123", authorization: "secret-token" },
        responseBody: "private output",
        url: "https://example.com?key=secret",
        requestBodyValues: { prompt: "private input" },
      },
    })
    expect(result.statusCode).toBe(413)
    expect(result.requestId).toBe("trace-123")
    expect(result.category).toBe("request_too_large")
    expect(result.requestBodyBytes).toBeGreaterThan(0)
    for (const secret of ["secret", "private", "example.com", "[object Object]"])
      expect(JSON.stringify(result)).not.toContain(secret)
  })
  test("handles nested retries, cycles, actual Headers and missing HTTP evidence", () => {
    const cause = {
      error: { statusCode: 429, code: "rate_limit", responseHeaders: new Headers({ "x-trace-id": "abc-42" }) },
    }
    Object.assign(cause, { cause })
    expect(providerErrorSummary({ lastError: cause }).statusCode).toBe(429)
    expect(providerErrorSummary({ lastError: cause }).requestId).toBe("abc-42")
    expect(providerErrorSummary({ error: new Error("socket connection lost") }).category).toBe("network_error")
    expect(providerErrorSummary({}).statusCode).toBeUndefined()
    expect(providerErrorSummary({}).message).toContain("unavailable")
  })
})

test("request composition records counts only", () => {
  const result = providerRequestSummary([
    {
      role: "tool",
      content: [
        { type: "text", text: "private" },
        { type: "image", image: "base64-private" },
      ],
    },
  ])
  expect(result).toEqual({ messageCount: 1, imageCount: 1, imageBytes: 14, textBytes: 7 })
  expect(JSON.stringify(result)).not.toContain("private")
})

test("retains numeric gateway code and uses the nested message for classification", () => {
  const result = providerErrorSummary({ error: { code: 400001, message: "read body failed" } })
  expect(result.code).toBe("400001")
  expect(result.category).toBe("request_too_large")
  expect(result.statusCode).toBeUndefined()
})

test("extracts allowlisted evidence from a bounded JSON response body without logging it", () => {
  const result = providerErrorSummary({
    error: {
      statusCode: 400,
      responseBody: JSON.stringify({
        error: { code: 400001, message: "read body failed", trace_id: "gateway-trace" },
        private: "sensitive response",
      }),
    },
  })
  expect(result.code).toBe("400001")
  expect(result.requestId).toBe("gateway-trace")
  expect(result.category).toBe("request_too_large")
  expect(JSON.stringify(result)).not.toContain("sensitive response")
})
