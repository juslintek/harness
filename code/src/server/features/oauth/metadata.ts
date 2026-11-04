export const SCOPES = ["board", "chat"] as const;
export type Scope = (typeof SCOPES)[number];

export const CODE_TTL_MS: number = 60_000;
export const ACCESS_TTL_MS: number = 60 * 60 * 1000;
export const REFRESH_TTL_MS: number = 30 * 24 * 60 * 60 * 1000;

export const resourceUrl = (origin: string): string => `${origin}/mcp/remote`;

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
  };
}
