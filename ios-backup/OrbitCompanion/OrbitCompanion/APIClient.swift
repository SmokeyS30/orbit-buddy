import Foundation

@MainActor
final class OrbitAPIClient: ObservableObject {
    @Published var user: OrbitUser?
    @Published var status: OrbitStatus?
    @Published var tasks: [OrbitTask] = []
    @Published var message = ""
    @Published var isBusy = false

    @Published var serverAddress: String {
        didSet { UserDefaults.standard.set(serverAddress, forKey: "orbit.server") }
    }

    private var csrf: String? {
        didSet { UserDefaults.standard.set(csrf, forKey: "orbit.csrf") }
    }

    init() {
        serverAddress = UserDefaults.standard.string(forKey: "orbit.server") ?? ""
        csrf = UserDefaults.standard.string(forKey: "orbit.csrf")
    }

    private var baseURL: URL? {
        let normalized = serverAddress.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: normalized), url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        guard let url = baseURL?.appending(path: path) else { throw OrbitAPIError.invalidServer }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let csrf, method != "GET" { request.setValue(csrf, forHTTPHeaderField: "X-Orbit-CSRF") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 500
        guard (200..<300).contains(code) else {
            let error = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw OrbitAPIError.rejected(error?.error ?? "Orbit rejected the request (HTTP \(code)).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func login(email: String, password: String) async {
        await perform {
            let auth: AuthEnvelope = try await request("api/auth/login", method: "POST", body: ["email": email, "password": password])
            user = auth.user
            csrf = auth.csrf
            try await refreshNow()
        }
    }

    func restoreSession() async {
        guard baseURL != nil else { return }
        await perform {
            let auth: AuthEnvelope = try await request("api/auth/me")
            user = auth.user
            csrf = auth.csrf
            try await refreshNow()
        }
    }

    func createTask(title: String, prompt: String) async {
        await perform {
            let _: OrbitTask = try await request("api/tasks", method: "POST", body: ["title": title, "prompt": prompt, "risk": "internal"])
            try await refreshNow()
        }
    }

    func pause() async {
        await perform {
            let _: PauseEnvelope = try await request("api/admin/pause", method: "POST", body: [:])
            try await refreshNow()
        }
    }

    func resume() async {
        await perform {
            let _: PauseEnvelope = try await request("api/admin/resume", method: "POST", body: ["confirm": "RESUME"])
            try await refreshNow()
        }
    }

    func refresh() async { await perform { try await refreshNow() } }

    private func refreshNow() async throws {
        async let currentStatus: OrbitStatus = request("api/status")
        async let snapshot: OrbitSnapshot = request("api/snapshot")
        status = try await currentStatus
        tasks = try await snapshot.tasks
    }

    private func perform(_ operation: () async throws -> Void) async {
        isBusy = true
        defer { isBusy = false }
        do { try await operation(); message = "" }
        catch { message = error.localizedDescription }
    }
}

private struct PauseEnvelope: Codable { let paused: Bool }
