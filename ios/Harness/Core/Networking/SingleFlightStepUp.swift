import Foundation

public actor SingleFlightStepUp {
    public static let shared = SingleFlightStepUp()

    private var currentTask: Task<Void, Error>?
    public private(set) var stepUpCount: Int = 0

    public init() {}

    public func execute(
        origin: String,
        sessionId: String,
        signer: DeviceKeySigning,
        fetchOptions: @escaping @Sendable () async throws -> MobileStepUpOptionsResponse,
        verifyStepUp: @escaping @Sendable (MobileStepUpVerifyRequest) async throws -> Void
    ) async throws {
        if let existing = currentTask {
            return try await existing.value
        }

        let task = Task<Void, Error> {
            let options = try await fetchOptions()
            let canonical = "harness-mobile-stepup-v1|\(origin)|\(sessionId)|\(options.challengeId)|\(options.nonce)"
            let signature = try await signer.sign(canonicalAscii: canonical)
            let verifyReq = MobileStepUpVerifyRequest(challengeId: options.challengeId, signature: signature)
            try await verifyStepUp(verifyReq)
        }

        currentTask = task
        stepUpCount += 1

        do {
            try await task.value
            currentTask = nil
        } catch {
            currentTask = nil
            throw error
        }
    }
}
