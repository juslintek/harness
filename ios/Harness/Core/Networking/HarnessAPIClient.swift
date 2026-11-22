import Foundation

public enum HarnessAPIError: Error, LocalizedError, Equatable {
    case invalidURL(String)
    case stepUpRequired
    case httpError(statusCode: Int, message: String)
    case decodingError(String)
    case unauthorized

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let url):
            return "Invalid URL: \(url)"
        case .stepUpRequired:
            return "Action requires step-up authentication."
        case .httpError(let code, let msg):
            return "HTTP \(code): \(msg)"
        case .decodingError(let msg):
            return "Decoding error: \(msg)"
        case .unauthorized:
            return "Session expired or unauthorized."
        }
    }
}

public final class HarnessAPIClient: Sendable {
    public let origin: String
    public let tokenProvider: @Sendable () -> String?
    public let sessionIdProvider: @Sendable () -> String?
    public let signer: DeviceKeySigning?
    public let session: URLSession
    public let stepUpCoordinator: SingleFlightStepUp

    public init(
        origin: String,
        tokenProvider: @escaping @Sendable () -> String?,
        sessionIdProvider: @escaping @Sendable () -> String? = { nil },
        signer: DeviceKeySigning? = nil,
        session: URLSession = .shared,
        stepUpCoordinator: SingleFlightStepUp = .shared
    ) {
        self.origin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.tokenProvider = tokenProvider
        self.sessionIdProvider = sessionIdProvider
        self.signer = signer
        self.session = session
        self.stepUpCoordinator = stepUpCoordinator
    }

    public func buildRequest(
        path: String,
        method: String = "GET",
        body: Data? = nil
    ) throws -> URLRequest {
        let fullPath = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: "\(origin)\(fullPath)") else {
            throw HarnessAPIError.invalidURL("\(origin)\(fullPath)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(origin, forHTTPHeaderField: "Origin")
        req.setValue("1", forHTTPHeaderField: "X-Harness-Mobile")
        if let token = tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        return req
    }

    public func send<T: Decodable>(
        _ request: URLRequest,
        allowStepUpRetry: Bool = true
    ) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw HarnessAPIError.httpError(statusCode: -1, message: "Non-HTTP response")
        }

        if httpResponse.statusCode == 403 {
            if let errResp = try? JSONDecoder().decode(APIErrorResponse.self, from: data),
               errResp.error == "step_up_required" {
                if allowStepUpRetry, let signer {
                    let providedSessionId = sessionIdProvider()
                    let sessionId: String
                    if let providedSessionId, !providedSessionId.isEmpty {
                        sessionId = providedSessionId
                    } else {
                        let meReq = try buildRequest(path: "/api/auth/me", method: "GET")
                        let me: MeResponse = try await send(meReq, allowStepUpRetry: false)
                        sessionId = me.session.id
                    }
                    try await stepUpCoordinator.execute(
                        origin: origin,
                        sessionId: sessionId,
                        signer: signer,
                        fetchOptions: { [weak self] in
                            guard let self else { throw HarnessAPIError.unauthorized }
                            return try await self.postStepUpOptions()
                        },
                        verifyStepUp: { [weak self] verifyReq in
                            guard let self else { throw HarnessAPIError.unauthorized }
                            _ = try await self.postStepUpVerify(verifyReq)
                        }
                    )
                    return try await send(request, allowStepUpRetry: false)
                } else {
                    throw HarnessAPIError.stepUpRequired
                }
            }
        }

        if httpResponse.statusCode == 401 {
            throw HarnessAPIError.unauthorized
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let errorMsg = String(data: data, encoding: .utf8) ?? "Unknown server error"
            throw HarnessAPIError.httpError(statusCode: httpResponse.statusCode, message: errorMsg)
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw HarnessAPIError.decodingError(error.localizedDescription)
        }
    }

    public func getMe() async throws -> MeResponse {
        let req = try buildRequest(path: "/api/auth/me")
        return try await send(req)
    }

    public func postStepUpOptions() async throws -> MobileStepUpOptionsResponse {
        let req = try buildRequest(path: "/api/auth/mobile/step-up/options", method: "POST")
        return try await send(req, allowStepUpRetry: false)
    }

    public func postStepUpVerify(_ body: MobileStepUpVerifyRequest) async throws -> MobileStepUpVerifyResponse {
        let bodyData = try JSONEncoder().encode(body)
        let req = try buildRequest(path: "/api/auth/mobile/step-up/verify", method: "POST", body: bodyData)
        return try await send(req, allowStepUpRetry: false)
    }

    public func postHalt(_ body: HaltRequest) async throws -> HaltResponse {
        let bodyData = try JSONEncoder().encode(body)
        let req = try buildRequest(path: "/api/halt", method: "POST", body: bodyData)
        return try await send(req)
    }

    public func postPairOptions(_ body: MobilePairOptionsRequest) async throws -> MobilePairOptionsResponse {
        let bodyData = try JSONEncoder().encode(body)
        let req = try buildRequest(path: "/api/auth/mobile/pair/options", method: "POST", body: bodyData)
        return try await send(req, allowStepUpRetry: false)
    }

    public func postPairVerify(_ body: MobilePairVerifyRequest) async throws -> MobilePairVerifyResponse {
        let bodyData = try JSONEncoder().encode(body)
        let req = try buildRequest(path: "/api/auth/mobile/pair/verify", method: "POST", body: bodyData)
        return try await send(req, allowStepUpRetry: false)
    }

    public func postEnrollOptions(code: String, _ body: MobileEnrollOptionsRequest) async throws -> MobileEnrollOptionsResponse {
        let bodyData = try JSONEncoder().encode(body)
        let req = try buildRequest(path: "/api/auth/mobile/enroll/\(code)/options", method: "POST", body: bodyData)
        return try await send(req, allowStepUpRetry: false)
    }

    public func postEnrollVerify(code: String, _ body: MobileEnrollVerifyRequest) async throws -> MobileEnrollVerifyResponse {
        let bodyData = try JSONEncoder().encode(body)
        let req = try buildRequest(path: "/api/auth/mobile/enroll/\(code)/verify", method: "POST", body: bodyData)
        return try await send(req, allowStepUpRetry: false)
    }
}
