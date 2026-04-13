/**
 * Cache-Control header helpers for API and page responses.
 *
 * Apply these to Next.js route handlers via the `headers` return value
 * or by setting response headers directly.
 */

export const cacheControl = {
  /**
   * Private, never cache.
   * Use for: auth routes, user-specific data, any endpoint with session state.
   */
  private(): string {
    return "private, no-cache, no-store, must-revalidate";
  },

  /**
   * Public, short-lived cache with stale-while-revalidate.
   * Use for: marketing pages, public API endpoints.
   * @param maxAge seconds before cache entry is considered stale
   */
  public(maxAge: number): string {
    return `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`;
  },

  /**
   * CDN-optimised: longer s-maxage than browser cache.
   * Use for: static assets served through a CDN, OpenAPI spec.
   * @param maxAge browser cache TTL in seconds
   */
  cdn(maxAge: number): string {
    return `public, max-age=${maxAge}, s-maxage=${maxAge * 2}, stale-while-revalidate`;
  },

  /**
   * Immutable: permanent cache (versioned assets only).
   * The URL MUST change when the content changes (e.g. via content hash).
   */
  immutable(): string {
    return "public, max-age=31536000, immutable";
  },

  /**
   * Health / status endpoints: always fetch fresh.
   */
  noStore(): string {
    return "no-store";
  },
} as const;

/**
 * Standard Vary header for JSON API responses.
 * Ensures CDNs/proxies cache separate copies for different encodings and content types.
 */
export const VARY_API = "Accept-Encoding, Accept";
