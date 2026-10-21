// UNVERIFIED: requires Xcode compilation and physical-device testing on the user's Mac.
import Foundation
import Capacitor
import AuthenticationServices
import DeviceCheck
import CryptoKit

@objc(SignupSecurityPlugin)
public class SignupSecurityPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "SignupSecurityPlugin"
    public let jsName = "SignupSecurity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "assert", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markRegistered", returnType: CAPPluginReturnPromise)
    ]
    private var pendingSignIn: CAPPluginCall?
    private var anchor: ASPresentationAnchor?
    private var authorizationController: ASAuthorizationController?
    private func storageKeys(_ call: CAPPluginCall) -> (key: String, registered: String) {
        // Separate test-server enrollment from production enrollment on a device.
        let namespace = call.getString("namespace") ?? "https://orbitbuddy.app"
        let digest = SHA256.hash(data: Data(namespace.utf8)).map { String(format: "%02x", $0) }.joined()
        return ("orbit.appAttest.key.v2." + digest, "orbit.appAttest.registered.v2." + digest)
    }

    @objc func signIn(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), nonce.count >= 32 else { call.reject("Missing server nonce"); return }
        DispatchQueue.main.async {
            guard self.pendingSignIn == nil else { call.reject("Sign-in already in progress"); return }
            guard let window = self.bridge?.viewController?.view.window else { call.reject("No active sign-in window"); return }
            self.anchor = window
            self.pendingSignIn = call
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.email, .fullName]
            request.nonce = nonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.authorizationController = controller
            controller.performRequests()
        }
    }
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return anchor ?? ASPresentationAnchor()
    }
    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        defer { pendingSignIn = nil; authorizationController = nil }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let token = credential.identityToken, let code = credential.authorizationCode,
              let tokenText = String(data: token, encoding: .utf8), let codeText = String(data: code, encoding: .utf8)
        else { pendingSignIn?.reject("Apple did not return credentials"); return }
        pendingSignIn?.resolve(["identityToken": tokenText, "authorizationCode": codeText])
    }
    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        pendingSignIn?.reject("Apple sign-in was cancelled or unavailable")
        pendingSignIn = nil; authorizationController = nil
    }
    @objc func getKey(_ call: CAPPluginCall) {
        guard DCAppAttestService.shared.isSupported else { call.resolve(["supported": false]); return }
        let keys = storageKeys(call)
        if let key = UserDefaults.standard.string(forKey: keys.key) {
            call.resolve(["supported": true, "keyId": key, "registered": UserDefaults.standard.bool(forKey: keys.registered)]); return
        }
        DCAppAttestService.shared.generateKey { key, error in
            guard let key = key, error == nil else { call.reject("App Attest unavailable"); return }
            UserDefaults.standard.set(key, forKey: keys.key)
            call.resolve(["supported": true, "keyId": key, "registered": false])
        }
    }
    @objc func attest(_ call: CAPPluginCall) {
        guard let key = call.getString("keyId"), let challenge = call.getString("challenge") else { call.reject("Missing challenge"); return }
        let hash = Data(SHA256.hash(data: Data(challenge.utf8)))
        DCAppAttestService.shared.attestKey(key, clientDataHash: hash) { result, error in
            guard let result = result, error == nil else { call.reject("App Attest unavailable"); return }
            call.resolve(["attestation": result.base64EncodedString()])
        }
    }
    @objc func assert(_ call: CAPPluginCall) {
        guard let key = call.getString("keyId"), let payload = call.getString("payload") else { call.reject("Missing payload"); return }
        let hash = Data(SHA256.hash(data: Data(payload.utf8)))
        DCAppAttestService.shared.generateAssertion(key, clientDataHash: hash) { result, error in
            guard let result = result, error == nil else { call.reject("App Attest unavailable"); return }
            call.resolve(["assertion": result.base64EncodedString()])
        }
    }
    @objc func markRegistered(_ call: CAPPluginCall) {
        let keys = storageKeys(call)
        guard let key = call.getString("keyId"), key == UserDefaults.standard.string(forKey: keys.key) else { call.reject("Enrollment key changed"); return }
        UserDefaults.standard.set(true, forKey: keys.registered); call.resolve()
    }
}
