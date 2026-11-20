/**
 * One definition of "this machine" for config validation and the HTTP transport, so the two can
 * never disagree (M0.5 audit, SEC-05). Hostnames are as given by the WHATWG URL parser (IPv6 in
 * brackets). Covers the whole 127.0.0.0/8 range, "localhost" and ::1.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}
