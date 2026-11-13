using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Harness.Core;

public enum ApiErrorKind { Unauthorized, Forbidden, NotImplemented, Server, Transport, Decoding }

public sealed class ApiException : Exception
{
    public ApiErrorKind Kind { get; }
    public int? Status { get; }
    public string? Code { get; }

    public ApiException(ApiErrorKind kind, string message, int? status = null, string? code = null, Exception? inner = null)
        : base(message, inner)
    {
        Kind = kind;
        Status = status;
        Code = code;
    }

    internal static ApiException Transport(string message, Exception? inner = null) =>
        new(ApiErrorKind.Transport, $"Could not reach the backend: {message}", inner: inner);
}

public sealed record User(string Id, string Email, string Name, bool InstanceAdmin, long CreatedAt);

public sealed record SessionSummary(string Id, string Method, long? StepUpAt, bool StepUpFresh);

public sealed record Me(User User, SessionSummary Session);

public sealed record SessionInfo(string Id, string Method, string? UserAgent, long CreatedAt, long LastSeenAt, long ExpiresAt, bool Current)
{
    public DateTimeOffset Created => DateTimeOffset.FromUnixTimeMilliseconds(CreatedAt);
    public DateTimeOffset LastSeen => DateTimeOffset.FromUnixTimeMilliseconds(LastSeenAt);
}

public sealed record Health(bool Ok, string InstanceId, string Version);

/// The session cookie lives only in this client's in-memory CookieContainer, so it dies with the process.
public sealed class ApiClient : IDisposable
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    readonly HttpClient http;
    public string Origin { get; }

    public ApiClient(int port)
    {
        // The server only accepts a localhost Origin/Host pair, not 127.0.0.1.
        Origin = $"http://localhost:{port}";
        http = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer(), UseCookies = true })
        {
            Timeout = TimeSpan.FromSeconds(15),
        };
    }

    public void Dispose() => http.Dispose();

    public async Task<Health> HealthAsync(CancellationToken ct = default) =>
        Decode<Health>(await SendAsync(HttpMethod.Get, "/api/health", null, ct));

    public async Task RequestCodeAsync(string email, CancellationToken ct = default) =>
        await SendAsync(HttpMethod.Post, "/api/auth/email/request", new { email }, ct);

    public async Task<User> VerifyAsync(string email, string code, CancellationToken ct = default) =>
        Decode<VerifyReply>(await SendAsync(HttpMethod.Post, "/api/auth/email/verify", new { email, code }, ct)).User;

    public async Task<Me> MeAsync(CancellationToken ct = default) =>
        Decode<Me>(await SendAsync(HttpMethod.Get, "/api/auth/me", null, ct));

    public async Task<IReadOnlyList<SessionInfo>> SessionsAsync(CancellationToken ct = default) =>
        Decode<List<SessionInfo>>(await SendAsync(HttpMethod.Get, "/api/auth/sessions", null, ct));

    public async Task RevokeSessionAsync(string id, CancellationToken ct = default) =>
        await SendAsync(HttpMethod.Delete, $"/api/auth/sessions/{Uri.EscapeDataString(id)}", null, ct);

    public async Task LogoutAsync(CancellationToken ct = default) =>
        await SendAsync(HttpMethod.Post, "/api/auth/logout", null, ct);

    /// Raw GET for routes that have no typed method yet.
    public Task<byte[]> GetAsync(string path, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Get, path, null, ct);

    sealed record VerifyReply(User User);
    sealed record ErrorBody(string Error);

    async Task<byte[]> SendAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        if (!Uri.TryCreate(Origin + path, UriKind.Absolute, out var url))
            throw ApiException.Transport($"bad path {path}");
        using var request = new HttpRequestMessage(method, url);
        request.Headers.TryAddWithoutValidation("Origin", Origin);
        if (body is not null)
            request.Content = new StringContent(JsonSerializer.Serialize(body, Json), Encoding.UTF8, "application/json");

        HttpStatusCode status;
        byte[] data;
        try
        {
            using var response = await http.SendAsync(request, ct);
            status = response.StatusCode;
            data = await response.Content.ReadAsByteArrayAsync(ct);
        }
        catch (HttpRequestException e)
        {
            throw ApiException.Transport(e.Message, e);
        }
        catch (OperationCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw ApiException.Transport("request timed out", e); // HttpClient.Timeout, not the caller
        }

        var code = (int)status;
        if (code is >= 200 and < 300) return data;
        switch (code)
        {
            case 401: throw new ApiException(ApiErrorKind.Unauthorized, "Not signed in, or the credentials were rejected.", code);
            case 403: throw new ApiException(ApiErrorKind.Forbidden, "This account is not allowed to do that.", code);
            case 501: throw new ApiException(ApiErrorKind.NotImplemented, "The backend does not implement this yet.", code);
        }
        string errorCode;
        try { errorCode = JsonSerializer.Deserialize<ErrorBody>(data, Json)?.Error ?? "unknown"; }
        catch (JsonException) { errorCode = "unknown"; }
        throw new ApiException(ApiErrorKind.Server, $"Server error {code}: {errorCode}", code, errorCode);
    }

    static T Decode<T>(byte[] data)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(data, Json) ?? throw new JsonException("empty body");
        }
        catch (JsonException e)
        {
            throw new ApiException(ApiErrorKind.Decoding, $"Unexpected response from the backend: {e.Message}", inner: e);
        }
    }
}
