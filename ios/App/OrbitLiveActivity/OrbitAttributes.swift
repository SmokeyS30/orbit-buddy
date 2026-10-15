import ActivityKit
import Foundation

/// Shared Live Activity model for Orbit Buddy.
///
/// This file is compiled into BOTH the main App target and the
/// OrbitLiveActivity WidgetKit extension target (same file, two targets),
/// so the two sides always agree on the attribute shape.
///
/// Data sharing: the attributes + content state below travel inside the
/// ActivityKit activity itself. The App Group `group.com.smokeys30.orbitbuddy`
/// (see entitlements) is reserved for future cross-process state such as
/// background-task progress written while the app is suspended.
public struct OrbitAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Activity kind: "voice" (spoken conversation) or "task" (long job).
        public var kind: String
        /// Short status line, e.g. "Listening…", "Thinking…", "Working on…".
        public var status: String
        /// Optional detail line, e.g. turn count or the task label.
        public var detail: String
        /// When the activity started (drives the elapsed timer in the UI).
        public var startedAt: Date

        public init(kind: String, status: String, detail: String = "", startedAt: Date = Date()) {
            self.kind = kind
            self.status = status
            self.detail = detail
            self.startedAt = startedAt
        }
    }

    /// What's running, e.g. "Voice chat" or the task title.
    public var title: String
    /// Buddy display name, so the widget can greet without shared defaults.
    public var buddyName: String
    /// Deep link opened when the user taps the activity (e.g. "orbitbuddy://voice").
    public var deepLink: String

    public init(title: String, buddyName: String, deepLink: String) {
        self.title = title
        self.buddyName = buddyName
        self.deepLink = deepLink
    }
}
