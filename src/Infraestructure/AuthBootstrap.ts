/**
 * The central VariaMos login returns external clients to localhost with a
 * short-lived token in the query string. Capture it before SessionProvider
 * performs its first request, then immediately remove it from the address bar.
 */
export function captureAuthTokenFromUrl(): void {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  const authToken = url.searchParams.get("authToken");
  if (!authToken) return;

  localStorage.setItem("authToken", authToken);
  url.searchParams.delete("authToken");
  window.history.replaceState({}, "", url.toString());
}
