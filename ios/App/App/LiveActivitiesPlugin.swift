import ActivityKit
import Capacitor
import Foundation

/// Capacitor bridge plugin exposing Live Activities to the web app.
///
/// JS name: `LiveActivities` (see public/live-activities.js).
/// Registered programmatically in OrbitBridgeViewController — `npx cap sync`
/// only knows about npm-installed plugins, so hand-written plugins in the
/// App target must be registered by hand.
///
/// Live Activities require iOS 16.1+. On older systems the plugin is never
/// registered and every JS call safely no-ops.
@available(iOS 16.1, *)
@objc(LiveActivitiesPlugin)
public class LiveActivitiesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivitiesPlugin"
    public let jsName = "LiveActivities"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "supportsLiveActivities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endActivity", returnType: CAPPluginReturnPromise),
    ]

    /// Running activities, keyed by the JS-supplied id (e.g. "voice", "task").
    private var activities: [String: Activity<OrbitAttributes>] = [:]

    /// App Group shared defaults (group.com.smokeys30.orbitbuddy). Mirrors the
    /// active activity metadata so the extension / background tasks can see it.
    private var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: "group.com.smokeys30.orbitbuddy")
    }

    // MARK: - Plugin methods

    @objc func supportsLiveActivities(_ call: CAPPluginCall) {
        call.resolve(["supported": ActivityAuthorizationInfo().areActivitiesEnabled])
    }

    /// options: { id, kind ("voice"|"task"), title, status, detail?, buddyName?, deepLink? }
    @objc func startActivity(_ call: CAPPluginCall) {
        let id = call.getString("id", UUID().uuidString)
        let kind = call.getString("kind", "task")
        let title = call.getString("title", kind == "voice" ? "Voice chat" : "Orbit is working")
        let status = call.getString("status", "")
        let detail = call.getString("detail", "")
        let buddyName = call.getString("buddyName", "Orbit")
        let deepLink = call.getString("deepLink", "orbitbuddy://")

        let attributes = OrbitAttributes(title: title, buddyName: buddyName, deepLink: deepLink)
        let state = OrbitAttributes.ContentState(kind: kind, status: status, detail: detail)

        do {
            // Replace any previous activity with the same id.
            if let existing = activities[id] {
                Task { await existing.end(nil, dismissalPolicy: .immediate) }
                activities.removeValue(forKey: id)
            }
            let activity = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
            activities[id] = activity
            mirrorToSharedDefaults(id: id, kind: kind, title: title, status: status)
            call.resolve(["id": id])
        } catch {
            call.reject("Could not start Live Activity: \(error.localizedDescription)")
        }
    }

    /// options: { id, status?, detail? } — updates the status/detail lines.
    @objc func updateActivity(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        guard let activity = activities[id] else {
            call.reject("No Live Activity with id '\(id)'")
            return
        }
        var state = activity.content.state
        let status = call.getString("status", "")
        let detail = call.getString("detail", "")
        if !status.isEmpty { state.status = status }
        if !detail.isEmpty { state.detail = detail }
        Task {
            await activity.update(ActivityContent(state: state, staleDate: nil))
            self.mirrorToSharedDefaults(id: id, kind: state.kind, title: activity.attributes.title, status: state.status)
            call.resolve()
        }
    }

    /// options: { id }
    @objc func endActivity(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        guard let activity = activities[id] else {
            // Ending something that isn't running is a no-op, not an error.
            call.resolve()
            return
        }
        activities.removeValue(forKey: id)
        clearSharedDefaults(id: id)
        Task {
            await activity.end(nil, dismissalPolicy: .immediate)
            call.resolve()
        }
    }

    // MARK: - App Group mirror

    private func mirrorToSharedDefaults(id: String, kind: String, title: String, status: String) {
        sharedDefaults?.set(
            ["kind": kind, "title": title, "status": status, "updatedAt": Date().timeIntervalSince1970],
            forKey: "orbit.liveActivity.\(id)"
        )
    }

    private func clearSharedDefaults(id: String) {
        sharedDefaults?.removeObject(forKey: "orbit.liveActivity.\(id)")
    }
}
