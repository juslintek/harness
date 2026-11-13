using System.Diagnostics;
using Harness.Core;

string binary;
try { binary = FindBinary(); }
catch (FileNotFoundException e)
{
    Console.Error.WriteLine($"FAIL setup: {e.Message}");
    return 1;
}

var started = new List<BackendProcess>();
var homes = new List<string>();

var scenarios = new (string Name, Func<Task> Run)[]
{
    ("start-health-stop-leaves-no-child", StartHealthStop),
    ("email-sign-in-flow", EmailSignInFlow),
    ("wrong-code-and-forbidden-route", WrongCodeAndForbidden),
    ("killed-child-is-reported", KilledChild),
};

var failed = false;
foreach (var (name, run) in scenarios)
{
    try
    {
        await run();
        Console.WriteLine($"PASS {name}");
    }
    catch (Exception e)
    {
        failed = true;
        Console.WriteLine($"FAIL {name}: {e.Message}");
    }
    finally
    {
        foreach (var backend in started) backend.Stop();
        foreach (var home in homes)
        {
            try { Directory.Delete(home, recursive: true); }
            catch (IOException) { } // temp dir, a leftover is harmless
        }
        started.Clear();
        homes.Clear();
    }
}
return failed ? 1 : 0;

static string FindBinary()
{
    var fromEnv = Environment.GetEnvironmentVariable("HARNESS_BIN");
    var tried = new List<string>();
    if (!string.IsNullOrEmpty(fromEnv)) tried.Add(fromEnv);
    else
        for (var dir = new DirectoryInfo(Directory.GetCurrentDirectory()); dir is not null; dir = dir.Parent)
            tried.Add(Path.Combine(dir.FullName, "zig", "zig-out", "bin", "harness"));
    foreach (var path in tried)
        if (File.Exists(path)) return path;
    throw new FileNotFoundException(
        $"harness binary not found (tried {(fromEnv is null or "" ? "zig/zig-out/bin/harness in every parent directory" : fromEnv)}). " +
        "Build it with: cd zig && zig build -Doptimize=ReleaseSafe -Dembed-ui=false (or set HARNESS_BIN)");
}

static void Expect(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

static async Task ExpectKind(Func<Task> call, ApiErrorKind kind, string what)
{
    try { await call(); }
    catch (ApiException e) when (e.Kind == kind) { return; }
    catch (ApiException e) { throw new Exception($"{what}: expected {kind}, got {e.Kind} ({e.Message})"); }
    throw new Exception($"{what}: expected {kind}, call succeeded");
}

static bool IsAlive(int pid)
{
    try { using var p = Process.GetProcessById(pid); return !p.HasExited; }
    catch (ArgumentException) { return false; }
}

static async Task<bool> WaitFor(Func<bool> condition)
{
    for (var i = 0; i < 100; i++)
    {
        if (condition()) return true;
        await Task.Delay(50);
    }
    return condition();
}

static Process Run(string binary, string[] args, Dictionary<string, string> env)
{
    var info = new ProcessStartInfo(binary) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var arg in args) info.ArgumentList.Add(arg);
    info.Environment.Clear();
    foreach (var (key, value) in env) info.Environment[key] = value;
    return Process.Start(info)!;
}

async Task<(BackendProcess Backend, ApiClient Client)> StartBackend()
{
    var home = Path.Combine(Path.GetTempPath(), $"harness-check-{Guid.NewGuid():N}");
    homes.Add(home);
    var backend = new BackendProcess(binary, home);
    started.Add(backend);
    try { await backend.StartAsync(); }
    catch (InvalidOperationException e)
    {
        throw new Exception($"backend not running: {e.Message}\n{string.Join('\n', backend.LogSnapshot().TakeLast(15))}");
    }
    return (backend, new ApiClient(backend.Port!.Value));
}

async Task Enroll(string email, BackendProcess backend, ApiClient client)
{
    using var child = Run(binary, ["enroll", "--email", email, "--name", "Test User"], new()
    {
        ["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "/usr/bin:/bin",
        ["HARNESS_HOME"] = backend.Home,
        ["HARNESS_ORIGIN"] = client.Origin,
    });
    var output = await Task.WhenAll(child.StandardOutput.ReadToEndAsync(), child.StandardError.ReadToEndAsync());
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    await child.WaitForExitAsync(timeout.Token);
    Expect(child.ExitCode == 0, $"harness enroll failed ({child.ExitCode}): {string.Join(' ', output)}");
}

async Task<string> EmailCode(string email, BackendProcess backend)
{
    var marker = $"email code for {email}: ";
    string? line = null;
    await WaitFor(() => (line = backend.LogSnapshot().LastOrDefault(l => l.Contains(marker))) is not null);
    if (line is null) throw new Exception($"no '{marker}' line in backend log: {string.Join(" | ", backend.LogSnapshot().TakeLast(10))}");
    return line[(line.IndexOf(marker, StringComparison.Ordinal) + marker.Length)..].Trim();
}

async Task StartHealthStop()
{
    var (backend, client) = await StartBackend();
    var health = await client.HealthAsync();
    Expect(health.Ok, "health not ok");
    Expect(health.InstanceId.Length > 0, "empty instance id");
    Expect(backend.Health == health, "BackendProcess.Health differs from a fresh /api/health");

    var pid = backend.Pid ?? throw new Exception("no pid");
    backend.Stop();
    Expect(await WaitFor(() => !IsAlive(pid)), $"child {pid} still alive after Stop()");
}

async Task EmailSignInFlow()
{
    var (backend, client) = await StartBackend();
    const string email = "flow@example.com";
    await Enroll(email, backend, client);
    await client.RequestCodeAsync(email);
    var user = await client.VerifyAsync(email, await EmailCode(email, backend));
    Expect(user.Email == email, $"verify returned {user.Email}");

    var me = await client.MeAsync();
    Expect(me.User.Email == email, $"me returned {me.User.Email}");
    Expect(me.Session.Method == "email", $"session method {me.Session.Method}");

    var sessions = await client.SessionsAsync();
    Expect(sessions.Count == 1 && sessions[0].Current, $"expected one current session, got {sessions.Count}");

    await client.LogoutAsync();
    await ExpectKind(() => client.MeAsync(), ApiErrorKind.Unauthorized, "me() after logout");
}

async Task WrongCodeAndForbidden()
{
    var (backend, client) = await StartBackend();
    const string email = "errors@example.com";
    await Enroll(email, backend, client);
    await client.RequestCodeAsync(email);

    await ExpectKind(() => client.VerifyAsync(email, "000000"), ApiErrorKind.Unauthorized, "wrong code");
    Expect((await client.HealthAsync()).Ok, "backend should survive a rejected code");

    await client.VerifyAsync(email, await EmailCode(email, backend));
    await ExpectKind(() => client.GetAsync("/api/runs"), ApiErrorKind.Forbidden, "non-admin GET /api/runs");
}

async Task KilledChild()
{
    var (backend, _) = await StartBackend();
    var exited = new TaskCompletionSource<string>();
    backend.Exited += reason => exited.TrySetResult(reason);
    var pid = backend.Pid ?? throw new Exception("no pid");
    Process.GetProcessById(pid).Kill(); // SIGKILL on Unix
    if (await Task.WhenAny(exited.Task, Task.Delay(5000)) != exited.Task)
        throw new Exception("Exited was not raised within 5 s of killing the child");
    Expect(backend.Pid is null, "Pid still set after unexpected exit");
}

