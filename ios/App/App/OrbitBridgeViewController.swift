import Capacitor

/// Registers Orbit's app-local StoreKit bridge before the web view starts.
/// Package plugins continue to auto-register from capacitor.config.json.
final class OrbitBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        if #available(iOS 15.0, *) {
            bridge?.registerPluginInstance(StoreKitPlugin())
            bridge?.registerPluginInstance(SignupSecurityPlugin())
        }
    }
}
