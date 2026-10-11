import SwiftUI

@main
struct OrbitCompanionApp: App {
    @StateObject private var client = OrbitAPIClient()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(client)
        }
    }
}
