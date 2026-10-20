# Orbit Buddy App Store submission notes

## Subscription catalog

| Plan | Product ID | Price |
| --- | --- | --- |
| Basic Monthly | `com.smokeys30.orbitbuddy.basic.monthly` | $2.99/month |
| Plus Monthly | `com.smokeys30.orbitbuddy.standard.monthly` | $5.99/month |
| Plus Yearly | `com.smokeys30.orbitbuddy.standard.yearly` | $59.99/year |
| Unlimited Monthly | `com.smokeys30.orbitbuddy.pro.monthly` | $19.99/month |

Every account includes 25 chat messages per New York calendar day before a
paid membership is required. Basic includes 100/day. Plus and Unlimited have
unlimited chat; Unlimited also receives stronger-model routing and longer live
conversation context.

## App Review notes

Orbit Buddy is a persistent AI companion for conversations, goals, reminders,
and background tasks. The iOS app uses StoreKit 2 for four auto-renewable
subscription products. The app sends the StoreKit signed transaction to the
Orbit backend, which validates it with Apple before granting an entitlement.
Restore Purchases is available directly below the membership choices.

Every account receives 25 included messages per New York calendar day. When
the allowance is used, Orbit preserves an in-chat return point and opens a
closable full-screen chooser for Basic, Plus, and Unlimited. It never interrupts
an assistant response in progress.

The subscription screen includes the auto-renewal disclosure, a Manage
Subscriptions link, Terms of Use, and Privacy Policy. Apple server notification
v2 events are received at:

`https://orbitbuddy.app/api/subscriptions/apple-notifications`

## Screenshot assets

- `screenshots/orbit-today-iphone-18-pro.jpg` — main Today experience.
- `screenshots/orbit-chat-iphone-18-pro.jpg` — sample conversation and composer.
- `screenshots/orbit-memberships-iphone-18-pro.jpg` — all three paid memberships,
  Restore Purchases, renewal disclosure, Terms, and Privacy.

All three screenshots are 1206 by 2622 pixels, RGB JPEGs captured from the
iPhone 18 Pro Simulator, an accepted Dynamic Island medium-display size.

## Safe activation order

1. Upload the subscription-capable build and complete sandbox purchase,
   renewal, expiry, refund, billing-retry, and restore testing.
2. Confirm the owner and the three approved complimentary emails return
   `comped: true` from the authenticated subscription status endpoint.
3. Attach the four subscription products to the same app-version submission.
4. Submit the app version and subscription group together for Apple's review.
5. Set `SUBSCRIPTIONS_ENABLED=true` only after the subscription-capable version
   is approved and available to users.

Until the last step, purchase testing remains available when Apple credentials
are configured, but the 25-message quota remains fail-open for every user.
