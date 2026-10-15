import SwiftUI
import WidgetKit

/// Widget bundle for the Orbit Buddy Live Activity extension.
///
/// Live Activities ONLY — no home-screen widget is registered here,
/// per Edward's call (2026-10-13: "I don't use widgets").
@main
struct OrbitLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        OrbitLiveActivity()
    }
}
