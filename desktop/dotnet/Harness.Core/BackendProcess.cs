using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Harness.Core;

public sealed class BackendProcess
{
    public const int MaxLogLines = 2000;
    public static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan StopGrace = TimeSpan.FromSeconds(3);

    const int SigTerm = 15;

    [DllImport("libc", SetLastError = true)]
    static extern int kill(int pid, int signal);

    readonly string binary;
    readonly object gate = new();
    readonly Queue<string> log = new();
    Process? process;
    int port;
    bool ready;
    bool stopping;
    string? exitReason;

    public string Home { get; }
    public Health? Health { get; private set; }
    public int? Pid { get; private set; }
    public int? Port { get { var p = Volatile.Read(ref port); return p == 0 ? null : p; } }

    /// Raised on a thread-pool thread for every stdout/stderr line.
    public event Action<string>? LineReceived;

    /// Raised when a child that was already running dies without Stop() being called.
    public event Action<string>? Exited;

    public BackendProcess(string binary, string? home = null)
    {
        this.binary = binary;
        Home = home ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Harness");
    }

    public string[] LogSnapshot()
    {
        lock (gate) return log.ToArray();
    }

    /// Returns once the backend answers /api/health. Throws InvalidOperationException if it never gets ready.
    public async Task StartAsync(CancellationToken ct = default)
    {
        lock (gate)
        {
            if (process is not null) throw new InvalidOperationException("backend already started");
        }
        if (!File.Exists(binary))
            throw new InvalidOperationException($"Cannot find the harness binary at {binary}. Pass its path to BackendProcess.");
        Directory.CreateDirectory(Home);

        var info = new ProcessStartInfo(binary)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add("serve");
        // Built from scratch so HARNESS_RUN_TOKEN, SANDBOX_RUNTIME and any secrets in the parent never reach the child.
        info.Environment.Clear();
        foreach (var name in new[] { "PATH", "HOME", "USERPROFILE", "SystemRoot" })
            if (Environment.GetEnvironmentVariable(name) is { } value) info.Environment[name] = value;
        info.Environment["HARNESS_HOST"] = "127.0.0.1";
        info.Environment["HARNESS_PORT"] = "0";
        info.Environment["HARNESS_HOME"] = Home;

        var child = new Process { StartInfo = info, EnableRaisingEvents = true };
        child.OutputDataReceived += (_, e) => OnLine(e.Data);
        child.ErrorDataReceived += (_, e) => OnLine(e.Data);
        child.Exited += (_, _) => OnExited(child);

        lock (gate)
        {
            process = child;
            stopping = false;
            ready = false;
            exitReason = null;
            Health = null;
        }
        Volatile.Write(ref port, 0);
        try
        {
            child.Start();
            Pid = child.Id;
            child.StandardInput.Close();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            await WaitUntilReadyAsync(ct);
        }
        catch
        {
            Abort(child);
            throw;
        }
    }

    /// Blocks for at most 2 * StopGrace, so it is safe to call from a window-closing handler.
    public void Stop()
    {
        Process? child;
        lock (gate)
        {
            stopping = true;
            ready = false;
            child = process;
            process = null;
            Pid = null;
        }
        if (child is null) return;
        if (!child.HasExited)
        {
            // .NET has no public SIGTERM; the backend shuts down cleanly on it, SIGKILL is the fallback.
            if (OperatingSystem.IsWindows()) child.Kill(entireProcessTree: true);
            else kill(child.Id, SigTerm);
            if (!child.WaitForExit(StopGrace))
            {
                child.Kill(entireProcessTree: true);
                child.WaitForExit(StopGrace);
            }
        }
        child.Dispose();
    }

    void OnLine(string? line)
    {
        if (line is null) return;
        const string marker = "listening on http://127.0.0.1:";
        if (Volatile.Read(ref port) == 0 && line.IndexOf(marker, StringComparison.Ordinal) is var at and >= 0)
        {
            var digits = new string(line.AsSpan(at + marker.Length).ToString().TakeWhile(char.IsAsciiDigit).ToArray());
            if (int.TryParse(digits, out var parsed)) Volatile.Write(ref port, parsed);
        }
        lock (gate)
        {
            log.Enqueue(line);
            while (log.Count > MaxLogLines) log.Dequeue();
        }
        LineReceived?.Invoke(line);
    }

    void OnExited(Process child)
    {
        string reason;
        bool wasReady;
        lock (gate)
        {
            if (child != process || stopping) return;
            reason = $"harness exited with code {child.ExitCode}";
            exitReason = reason;
            wasReady = ready;
            if (wasReady)
            {
                process = null;
                Pid = null;
                ready = false;
            }
        }
        if (wasReady) Exited?.Invoke(reason);
    }

    async Task WaitUntilReadyAsync(CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + ReadyTimeout;
        while (Port is null)
        {
            ThrowIfExited();
            if (DateTime.UtcNow > deadline)
                throw new InvalidOperationException($"harness did not print its listening address within {ReadyTimeout.TotalSeconds:0} s");
            await Task.Delay(50, ct);
        }
        using var client = new ApiClient(Port.Value);
        while (true)
        {
            ThrowIfExited();
            try
            {
                var health = await client.HealthAsync(ct);
                if (health.Ok)
                {
                    lock (gate)
                    {
                        ThrowIfExited();
                        Health = health;
                        ready = true;
                    }
                    return;
                }
            }
            catch (ApiException) { }
            if (DateTime.UtcNow > deadline)
                throw new InvalidOperationException($"harness did not answer /api/health within {ReadyTimeout.TotalSeconds:0} s");
            await Task.Delay(100, ct);
        }
    }

    void ThrowIfExited()
    {
        if (exitReason is { } reason) throw new InvalidOperationException($"{reason} before it was ready");
    }

    void Abort(Process child)
    {
        lock (gate)
        {
            if (process == child) process = null;
            Pid = null;
        }
        try { if (!child.HasExited) child.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { } // never started, or it exited between the check and the kill
        child.Dispose();
    }
}
