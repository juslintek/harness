import Foundation
import Observation

public enum BackendState: Equatable, Sendable {
    case stopped
    case starting
    case running(port: Int)
    /// Never became ready: missing binary, early exit, or no health response in time.
    case failed(String)
    /// Was running and the child died without us asking.
    case exited(String)
}

private struct Failure: Error {
    let message: String
}

/// What to run for the backend. Both servers print the same listening line and read the same HARNESS_* variables.
public struct BackendLaunch: Sendable {
    public let executable: URL
    public let arguments: [String]
    public let directory: URL?

    public static func zig(binary: URL) -> BackendLaunch {
        BackendLaunch(executable: binary, arguments: ["serve"], directory: nil)
    }

    /// The TypeScript server: `bun src/main.ts serve` inside the `code/` directory.
    public static func bun(serverDir: URL) throws -> BackendLaunch {
        let fileManager = FileManager.default
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        // A GUI launch has a short PATH, so the usual Homebrew locations are tried too.
        let candidates = path.split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin"]
        guard let bun = candidates.map({ URL(fileURLWithPath: $0).appendingPathComponent("bun") })
            .first(where: { fileManager.isExecutableFile(atPath: $0.path) })
        else {
            throw Failure(message: "Cannot find bun on PATH (tried \(path)). Install bun, or unset HARNESS_SERVER_DIR to use the Zig binary.")
        }
        guard fileManager.fileExists(atPath: serverDir.appendingPathComponent("src/main.ts").path) else {
            throw Failure(message: "HARNESS_SERVER_DIR \(serverDir.path) has no src/main.ts.")
        }
        guard fileManager.fileExists(atPath: serverDir.appendingPathComponent("node_modules").path) else {
            throw Failure(message: "\(serverDir.path) has no node_modules. Run `bun install` there.")
        }
        return BackendLaunch(executable: bun, arguments: ["src/main.ts", "serve"], directory: serverDir)
    }
}

/// Splits a byte stream into lines across arbitrary chunk boundaries.
private final class LineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Data()

    func feed(_ data: Data) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        pending.append(data)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            lines.append(String(decoding: pending[pending.startIndex..<newline], as: UTF8.self))
            pending.removeSubrange(pending.startIndex...newline)
        }
        return lines
    }

    func finish() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        defer { pending = Data() }
        return pending.isEmpty ? [] : [String(decoding: pending, as: UTF8.self)]
    }
}

@MainActor @Observable
public final class BackendProcess {
    public static let maxLogLines = 2000
    public static let readyTimeout: TimeInterval = 10
    public static let stopGrace: TimeInterval = 3

    public private(set) var state: BackendState = .stopped
    public private(set) var log: [String] = []
    public private(set) var health: Health?
    public private(set) var pid: Int32?
    public let home: URL

    @ObservationIgnored private let launchOverride: BackendLaunch?
    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var listeningPort: Int?
    @ObservationIgnored private var stopping = false

    public init(home: URL? = nil, launch: BackendLaunch? = nil) {
        self.home = home ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Harness")
        self.launchOverride = launch
    }

    /// Returns once the state is `.running`, `.failed` or `.stopped`; never throws.
    public func start() async {
        guard process == nil, state != .starting else { return }
        state = .starting
        health = nil
        listeningPort = nil
        stopping = false
        do {
            let launch = try resolveLaunch()
            try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
            let child = Process()
            child.executableURL = launch.executable
            child.arguments = launch.arguments
            child.currentDirectoryURL = launch.directory
            child.environment = childEnvironment()
            child.standardInput = FileHandle.nullDevice
            let out = Pipe()
            let err = Pipe()
            child.standardOutput = out
            child.standardError = err
            attach(out)
            attach(err)
            child.terminationHandler = { [weak self] finished in
                Task { @MainActor in self?.didExit(finished) }
            }
            try child.run()
            process = child
            pid = child.processIdentifier
            try await waitUntilReady()
        } catch let failure as Failure {
            fail(failure.message)
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// Blocks for at most `stopGrace` seconds, so it is safe to call from applicationWillTerminate.
    public func stop() {
        stopping = true
        defer { state = .stopped }
        guard let child = process else { return }
        if child.isRunning { child.terminate() }
        wait(for: child, seconds: Self.stopGrace)
        if child.isRunning {
            kill(child.processIdentifier, SIGKILL)
            wait(for: child, seconds: Self.stopGrace)
        }
        process = nil
        pid = nil
    }

    private func wait(for child: Process, seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while child.isRunning, Date() < deadline { usleep(20_000) }
    }

    private func resolveLaunch() throws -> BackendLaunch {
        if let launchOverride { return launchOverride }
        let fileManager = FileManager.default
        let environment = ProcessInfo.processInfo.environment
        if let serverDir = environment["HARNESS_SERVER_DIR"], !serverDir.isEmpty {
            return try .bun(serverDir: URL(fileURLWithPath: serverDir))
        }
        let fromEnv = environment["HARNESS_BIN"].flatMap { $0.isEmpty ? nil : $0 }
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("harness").path
        for path in [fromEnv, bundled].compactMap({ $0 }) where fileManager.isExecutableFile(atPath: path) {
            return .zig(binary: URL(fileURLWithPath: path))
        }
        throw Failure(message: """
            Cannot find the harness binary. Set HARNESS_BIN to its path \
            (tried: \(fromEnv ?? "HARNESS_BIN unset")), or place it at \
            Contents/Resources/harness inside the app bundle (tried: \(bundled ?? "no bundle resources")).
            """)
    }

    private func childEnvironment() -> [String: String] {
        let parent = ProcessInfo.processInfo.environment
        // Built from scratch so HARNESS_RUN_TOKEN, SANDBOX_RUNTIME and any secrets in the parent never reach the child.
        return [
            "PATH": parent["PATH"] ?? "/usr/bin:/bin",
            "HOME": parent["HOME"] ?? NSHomeDirectory(),
            "HARNESS_HOST": "127.0.0.1",
            "HARNESS_PORT": "0",
            "HARNESS_HOME": home.path,
        ]
    }

    private func attach(_ pipe: Pipe) {
        let buffer = LineBuffer()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            let lines: [String]
            if data.isEmpty {
                handle.readabilityHandler = nil
                lines = buffer.finish()
            } else {
                lines = buffer.feed(data)
            }
            if !lines.isEmpty { Task { @MainActor in self?.append(lines) } }
        }
    }

    private func append(_ lines: [String]) {
        for line in lines where listeningPort == nil {
            if let range = line.range(of: "listening on http://127.0.0.1:") {
                listeningPort = Int(line[range.upperBound...].prefix(while: \.isNumber))
            }
        }
        log.append(contentsOf: lines)
        if log.count > Self.maxLogLines { log.removeFirst(log.count - Self.maxLogLines) }
    }

    private func waitUntilReady() async throws {
        let deadline = Date().addingTimeInterval(Self.readyTimeout)
        while listeningPort == nil {
            try ensureStarting()
            if Date() > deadline { throw Failure(message: "harness did not print its listening address within \(Int(Self.readyTimeout)) s") }
            try await Task.sleep(for: .milliseconds(50))
        }
        let client = APIClient(port: listeningPort ?? 0)
        while true {
            try ensureStarting()
            if let health = try? await client.health(), health.ok {
                guard state == .starting else { return }
                self.health = health
                state = .running(port: listeningPort ?? 0)
                return
            }
            if Date() > deadline { throw Failure(message: "harness did not answer /api/health within \(Int(Self.readyTimeout)) s") }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    /// The child may have exited (state already .failed) or stop() may have run while we were waiting.
    private func ensureStarting() throws {
        guard state == .starting else { throw Failure(message: "startup interrupted") }
    }

    private func fail(_ message: String) {
        guard state == .starting else { return }
        if let child = process, child.isRunning { kill(child.processIdentifier, SIGKILL) }
        process = nil
        pid = nil
        state = .failed(message)
    }

    private func didExit(_ finished: Process) {
        guard process === finished, !stopping else { return }
        process = nil
        pid = nil
        let how = finished.terminationReason == .uncaughtSignal
            ? "was killed by signal \(finished.terminationStatus)"
            : "exited with status \(finished.terminationStatus)"
        state = state == .starting ? .failed("harness \(how) before it was ready") : .exited("harness \(how)")
    }
}
