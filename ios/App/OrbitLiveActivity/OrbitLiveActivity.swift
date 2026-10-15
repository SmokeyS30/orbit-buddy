import ActivityKit
import SwiftUI
import WidgetKit

/// Lock screen + Dynamic Island presentation for Orbit's Live Activities.
///
/// NOTE: this is a Live Activity extension ONLY — there is deliberately no
/// home-screen widget in this target (Edward: "I don't use widgets").
struct OrbitLiveActivity: Widget {
    private func tapURL(for context: ActivityViewContext<OrbitAttributes>) -> URL {
        URL(string: context.attributes.deepLink) ?? URL(string: "orbitbuddy://")!
    }

    private func iconName(for kind: String) -> String {
        kind == "voice" ? "mic.circle.fill" : "gearshape.circle.fill"
    }

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OrbitAttributes.self) { context in
            // MARK: Lock screen / banner
            HStack(spacing: 12) {
                Image(systemName: iconName(for: context.state.kind))
                    .font(.system(size: 32))
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.title)
                        .font(.headline)
                    if !context.state.status.isEmpty {
                        Text(context.state.status)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if !context.state.detail.isEmpty {
                        Text(context.state.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text(context.state.startedAt, style: .timer)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding()
            .widgetURL(tapURL(for: context))
            .activityBackgroundTint(Color(.systemBackground).opacity(0.92))
        } dynamicIsland: { context in
            DynamicIsland {
                // MARK: Expanded
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(context.attributes.title)
                            .font(.headline)
                    } icon: {
                        Image(systemName: iconName(for: context.state.kind))
                    }
                    .foregroundStyle(.tint)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.startedAt, style: .timer)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        if !context.state.status.isEmpty {
                            Text(context.state.status)
                                .font(.subheadline)
                        }
                        if !context.state.detail.isEmpty {
                            Text(context.state.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: iconName(for: context.state.kind))
                    .foregroundStyle(.tint)
            } compactTrailing: {
                Text(context.state.startedAt, style: .timer)
                    .font(.caption2.monospacedDigit())
            } minimal: {
                Image(systemName: iconName(for: context.state.kind))
                    .foregroundStyle(.tint)
            }
            .widgetURL(tapURL(for: context))
            .keylineTint(.tint)
        }
    }
}
