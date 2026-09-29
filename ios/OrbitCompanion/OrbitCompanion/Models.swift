import Foundation

struct OrbitUser: Codable {
    let id: String
    let email: String
    let displayName: String
    let role: String
}

struct AuthEnvelope: Codable {
    let user: OrbitUser
    let csrf: String
}

struct OrbitStatus: Codable {
    let buddyName: String
    let model: String
    let modelConfigured: Bool
    let version: String
    let paused: Bool
    let pushConfigured: Bool
    let role: String
}

struct OrbitTask: Codable, Identifiable {
    let id: String
    let title: String
    let prompt: String
    let status: String
    let risk: String
    let scheduleAt: String?
    let result: String?

    enum CodingKeys: String, CodingKey {
        case id, title, prompt, status, risk, result
        case scheduleAt = "schedule_at"
    }
}

struct OrbitSnapshot: Codable {
    let tasks: [OrbitTask]
}

struct ErrorEnvelope: Codable {
    let error: String
}

enum OrbitAPIError: LocalizedError {
    case invalidServer
    case rejected(String)

    var errorDescription: String? {
        switch self {
        case .invalidServer: "Enter a valid HTTPS Orbit server address."
        case .rejected(let message): message
        }
    }
}
