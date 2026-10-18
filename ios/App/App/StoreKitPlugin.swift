//
//  StoreKitPlugin.swift
//  App
//
//  Capacitor bridge for StoreKit 2 subscriptions (iOS 15+).
//
//  JS contract (plugin name "StoreKit", called from JS via the low-level
//  window.Capacitor bridge):
//    - nativePromise("StoreKit", "getProducts", { productIds: [String] })
//        -> { products: [{ id, title, description, price, currencyCode, type }] }
//    - nativePromise("StoreKit", "purchase", { productId: String, appAccountToken: String })
//        -> { signedTransaction: String }   // the transaction JWS
//        -> { pending: true }                // Ask to Buy — see below
//        -> rejects with code "cancelled" on user cancellation
//      appAccountToken is a UUID string issued by the server identifying the
//      Orbit user; it is attached to the transaction so the backend can match
//      the purchase to the account when verifying the JWS.
//    - nativePromise("StoreKit", "restore", {})
//        -> { transactions: [{ signedTransaction: String }] } (verified only)
//    - addListener("StoreKit", "transactionUpdated", cb)
//        -> { signedTransaction: String } whenever a verified transaction lands
//           outside a direct purchase() call (renewals, Ask-to-Buy approvals,
//           billing-issue resolutions, ...).
//
//  CRITICAL — ENTITLEMENT LIFECYCLE:
//  This plugin NEVER calls transaction.finish(). Every verified JWS is handed
//  to the JS layer, the backend verifies it with Apple's servers and grants
//  the entitlement, and only then is the transaction finished (server-side via
//  the App Store Server API, once the JS layer confirms). Finishing here would
//  acknowledge the transaction before the backend confirmed it, which risks
//  granting nothing for a paid purchase — so finish() has no place in this
//  file by design. Unverified transactions are never finished either; they are
//  simply reported as failures and ignored.
//
//  The Transaction.updates listener starts lazily on the first plugin call
//  (the JS paywall always calls getProducts first, so no event is missed in
//  practice) and is cancelled when the plugin is deallocated.
//

import Foundation
import StoreKit
import Capacitor

@available(iOS 15.0, *)
@objc(StoreKitPlugin)
public class StoreKitPlugin: CAPPlugin {

    // Long-lived Transaction.updates listener. Started lazily, cancelled here
    // so it can never outlive the plugin.
    private var transactionUpdatesTask: Task<Void, Never>?

    deinit {
        transactionUpdatesTask?.cancel()
    }

    // MARK: - getProducts

    /// Resolves { products: [...] } for the requested ids.
    /// Ids that App Store Connect doesn't know are simply absent from the
    /// returned list — Product.products(for:) omits unknown ids rather than
    /// throwing.
    @objc func getProducts(_ call: CAPPluginCall) {
        ensureUpdatesListenerRunning()
        guard let productIds = call.getArray("productIds") as? [String], !productIds.isEmpty else {
            call.reject("Missing or empty productIds array", "invalid_argument")
            return
        }
        Task { @MainActor in
            do {
                let products = try await Product.products(for: productIds)
                let list: [[String: Any]] = products.map { product in
                    [
                        "id": product.id,
                        "title": product.displayName,
                        "description": product.description,
                        "price": NSDecimalNumber(decimal: product.price).doubleValue,
                        "currencyCode": product.priceFormatStyle.currencyCode ?? "",
                        "type": productTypeName(product.type)
                    ]
                }
                call.resolve(["products": list])
            } catch {
                call.reject("Failed to load products: \(error.localizedDescription)", "products_failed", error)
            }
        }
    }

    // MARK: - purchase

    /// Purchases one product, tagging the transaction with the server-issued
    /// appAccountToken (a UUID string identifying the Orbit user) so the
    /// backend can match the transaction to the account when it verifies
    /// the JWS.
    ///
    /// Outcomes:
    /// - success + verified   -> resolves { signedTransaction } (JWS). NOT finished here.
    /// - success + unverified -> rejects "unverified_transaction". NOT finished,
    ///                           no entitlement is granted.
    /// - userCancelled        -> rejects with code "cancelled".
    /// - pending (Ask to Buy) -> resolves { pending: true }. NOT finished; the
    ///                           parent's approval arrives via Transaction.updates
    ///                           and is forwarded through "transactionUpdated".
    @objc func purchase(_ call: CAPPluginCall) {
        ensureUpdatesListenerRunning()
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("Missing productId", "invalid_argument")
            return
        }
        guard let tokenString = call.getString("appAccountToken"),
              let appAccountToken = UUID(uuidString: tokenString) else {
            call.reject("Missing or invalid appAccountToken (must be a UUID string)", "invalid_argument")
            return
        }
        Task { @MainActor in
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("Product not found: \(productId)", "product_not_found")
                    return
                }
                let result = try await product.purchase(options: [.appAccountToken(appAccountToken)])
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let transaction):
                        // NEVER finish() here — see the contract comment at the
                        // top of this file.
                        guard let signed = signedTransactionJWS(transaction) else {
                            call.reject("Transaction had no signed representation", "empty_transaction")
                            return
                        }
                        call.resolve(["signedTransaction": signed])
                    case .unverified(_, _):
                        // Do NOT finish, do NOT grant any entitlement — the
                        // transaction failed Apple's own verification, so just
                        // report the failure.
                        call.reject("Transaction could not be verified by StoreKit", "unverified_transaction")
                    }
                case .userCancelled:
                    call.reject("User cancelled the purchase", "cancelled")
                case .pending:
                    // Ask to Buy: the transaction is waiting on a parent's
                    // approval. Do NOT finish — the approved transaction will
                    // surface through Transaction.updates and be forwarded via
                    // the "transactionUpdated" event.
                    call.resolve(["pending": true])
                @unknown default:
                    call.reject("Unknown purchase result", "unknown_result")
                }
            } catch {
                call.reject("Purchase failed: \(error.localizedDescription)", "purchase_failed", error)
            }
        }
    }

    // MARK: - restore

    /// Returns the JWS of every verified current entitlement so the backend
    /// can re-sync the account. Verified transactions only; nothing is
    /// finished here.
    @objc func restore(_ call: CAPPluginCall) {
        ensureUpdatesListenerRunning()
        Task { @MainActor in
            var transactions: [[String: String]] = []
            for await result in Transaction.currentEntitlements {
                switch result {
                case .verified(let transaction):
                    if let signed = signedTransactionJWS(transaction) {
                        transactions.append(["signedTransaction": signed])
                    }
                case .unverified(_, _):
                    // Verified transactions only; unverified ones are ignored
                    // (and never finished).
                    continue
                }
            }
            call.resolve(["transactions": transactions])
        }
    }

    // MARK: - Transaction updates

    /// Starts the long-lived listener for transactions that arrive outside a
    /// direct purchase() call: renewals, Ask-to-Buy approvals, resolved
    /// billing issues, etc. Each verified transaction is forwarded to JS as a
    /// "transactionUpdated" event carrying its JWS. Unverified updates are
    /// silently ignored — no notification, no finish.
    ///
    /// The task captures self weakly and is cancelled in deinit, so it can
    /// never keep the plugin alive.
    private func ensureUpdatesListenerRunning() {
        guard transactionUpdatesTask == nil else { return }
        transactionUpdatesTask = Task { @MainActor [weak self] in
            for await update in Transaction.updates {
                guard let self else { break }
                switch update {
                case .verified(let transaction):
                    guard let signed = self.signedTransactionJWS(transaction) else { continue }
                    // NEVER finish() here — the backend finishes via the
                    // App Store Server API after verifying the JWS.
                    self.notifyListeners("transactionUpdated", data: ["signedTransaction": signed])
                case .unverified(_, _):
                    // Ignore: do not notify, do not finish.
                    continue
                }
            }
        }
    }

    // MARK: - Helpers

    /// The transaction's JWS string, or nil if the bytes can't be decoded.
    private func signedTransactionJWS(_ transaction: Transaction) -> String? {
        String(data: transaction.jsonRepresentation, encoding: .utf8)
    }

    private func productTypeName(_ type: Product.ProductType) -> String {
        switch type {
        case .autoRenewable: return "autoRenewable"
        case .nonRenewable: return "nonRenewable"
        case .consumable: return "consumable"
        case .nonConsumable: return "nonConsumable"
        @unknown default: return "unknown"
        }
    }
}
