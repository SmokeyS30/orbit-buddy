import Capacitor
import UIKit

/// CAPBridgeViewController subclass for the Orbit Buddy app.
///
/// Exists for one reason: `npx cap sync` only registers npm-installed
/// plugins (via capacitor.config.json's packageClassList). Hand-written
/// plugins compiled into the App target — currently LiveActivitiesPlugin —
/// must be registered on the bridge by hand, which is what happens here.
class OrbitBridgeViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        if #available(iOS 16.1, *) {
            // Live Activities need iOS 16.1+; older systems simply skip
            // registration and the JS helper no-ops.
            bridge?.registerPluginInstance(LiveActivitiesPlugin())
        }
    }
}
