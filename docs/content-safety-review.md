# Content safety and report review for the pending 1.1 replacement

Apple Developer Support case 102995865538 described four Guideline 1.2 safeguards for interactive AI apps. [Apple's published Guideline 1.2](https://developer.apple.com/app-store/review/guidelines/) currently confirms them and calls out nonconsensual intimate imagery, including AI content. This file records the code paths and the owner's review work. The email was general guidance, not an approval or rejection of this build. It gave no specific response deadline.

## Filtering objectionable material

`src/model.js` instructs both full chat and fast social chat to avoid targeted harassment, threats, sexual exploitation, nonconsensual intimate imagery of real people, graphic sexual violence, and harm instructions while still helping people discussing abuse or a crisis. `src/objectionable-content.js` adds a local high-confidence output check for direct threats, incitement, explicit nonconsensual intimate-image instructions, and exploitative instructions. `server.js` applies it to streamed assistant text, legacy model markers, and the stored/delivered assistant reply. Filtered text is replaced; the raw output is not stored as a chat message or included in the filter audit event, and filtered legacy markers cannot create a memory or follow-up. User messages are never blocked by this check, so people can ask for help. Tests cover direct harmful output, quoted discussion, crisis support, the stream, storage, and legacy markers.

This is a conservative local method, not a complete classifier. Indirect or novel objectionable output may pass; quoted language can still be misclassified. The per-response report control provides an owner review path for misses. Daybreak Partner should verify with a local fixture on iOS and include this limitation in App Review notes if safety behavior is discussed. Do not claim every objectionable response is detected.

## Offensive-content reports and timely handling

A signed-in user can report an Orbit response from its message menu or send an app problem from Safety. The user chooses a reason, edits an optional description and response excerpt, sees an exact preview, and consents before submission. No full chat history is attached automatically. Server checks ownership, size, rate limits, CSRF, and idempotency. The owner-only Safety inbox shows open counts, oldest open age, and oldest open items first; the owner can mark new, reviewing, resolved, or dismissed and write a short response visible only to the reporter in **Your reports**. Reporter receipts are scoped to their own account. Tests cover authorization, duplicate submissions, privacy, safe rendering, and SQLite/PostgreSQL persistence.

The owner must actually review this queue, investigate promptly, and send a meaningful response through the owner note before closing an offensive report. Code cannot ensure a human responds on time. The current implementation does not send a push or email when a report arrives; the owner must open Safety and check. The owner should decide an operating cadence and coverage before submission. The Apple email does not specify a numeric deadline, so this document does not invent one.

## Blocking abusive users

Orbit's app conversation is private between each account and Orbit; there is no in-app user-to-user feed, direct message, or shared room. The optional WhatsApp link routes a linked account to its own Orbit conversation. Sharing/exporting a conversation is initiated by the account holder to an external destination. There is therefore no peer user whose content another user can block inside Orbit.

For service abuse, Safety's owner-only Users list offers a reversible **Block account** control for non-demo member accounts. It disables the account, revokes its sessions, stops password/Apple sign-in, and keeps a moderation flag so an access-request approval cannot silently restore it. The owner account and users disabled for another reason cannot be blocked through this control. Only the owner can restore a moderation block. No accounts were blocked as part of this cloud work; tests use temporary local accounts. Whether Apple expects a peer-block UI for this one-to-one architecture should be confirmed with Apple if App Review raises it; do not claim an exemption.

## Published contact information

`/support.html` is a public support page linked from the welcome, privacy, terms, and signed-in Safety surfaces. It links to the project's existing GitHub Issues form. That form is public and requires GitHub sign-in; the page now warns not to post account email or secrets. Signed-in users have the private in-app report route. A private unauthenticated contact channel for account lockouts or privacy requests is not verified in this repository. The owner should provide and verify one if needed before claiming complete account-support coverage; do not invent an email address.

## Local verification and remaining gates

The full local suite covers API and UI state logic, PostgreSQL migrations, and local browser layouts. A clean iOS Simulator build has also passed from the isolated integration worktree. Real-device Dynamic Type, push delivery, real model behavior, App Review acceptance, a fresh distribution archive, and matching backend deployment still require release-path verification. Existing archive 1.1.1/build 20261026 predates these changes and must not be reused; the replacement remains App Store version 1.1 and uses a new build number.
