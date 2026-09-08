import SwiftUI
import TodoCueKit

/// Everything finished, newest first, grouped by the day it was finished on.
///
/// The Today tab only ever shows the current day's completions and the calendar only shows one
/// day at a time, so this is the one place that answers "what did I get done" across time and
/// "where did that task go" by name.
struct CompletedView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @State private var query = ""

    var body: some View {
        GeometryReader { geometry in
            // Match the list's gutter ramp: 12pt at 300pt, 16pt at 340pt and above.
            let inset = min(16, 12 + max(0, geometry.size.width - Theme.panelMinWidth) * 0.1)
            VStack(spacing: 10) {
                SearchField(query: $query, placeholder: L10n.tr("搜索已完成的任务"))
                    .padding(.horizontal, inset)
                ScrollView {
                    CompletedList(query: query)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollIndicators(.automatic)
                .cueSurface(radius: 18)
                .padding(.horizontal, inset)
                .padding(.bottom, 12)
            }
        }
        .onAppear { if model.completedTasks.isEmpty { model.loadCompleted(reset: true) } }
    }
}

/// The grouped history itself. Split out of `CompletedView` so it can be rendered without a
/// scroll container — `ImageRenderer` lays `ScrollView` out at zero height, which would otherwise
/// leave this surface with no verifiable evidence at all.
struct CompletedList: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    var query: String = ""

    private var matches: [TodoTask] { CompletedHistory.matching(model.completedTasks, query: query) }
    private var days: [CompletedHistory.Day] {
        CompletedHistory.days(matches, timezone: model.runtimeTimezone)
    }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.completedTasks.isEmpty {
                placeholder
            } else {
                if days.isEmpty {
                    Text(L10n.tr("没有找到相关任务"))
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .padding(.horizontal, 4).padding(.vertical, 10)
                } else {
                    ForEach(days) { day in
                        VStack(spacing: 2) {
                            SectionHeader(title: TCDate.dateLabel(day.date, language: languagePreferences.language,
                                                                  today: model.runtimeToday),
                                          count: day.tasks.count)
                            ForEach(day.tasks) { task in TaskRowView(task: task, compact: true) }
                        }
                    }
                }
                // Also on a fruitless search: that is exactly when someone needs to be told only
                // part of the history was searched, and given the control to widen it.
                footer
            }
        }
    }

    @ViewBuilder private var placeholder: some View {
        if model.isLoadingCompleted {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(L10n.tr("正在加载已完成的任务")).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4).padding(.vertical, 10)
        } else if model.completedLoadFailed || model.client == nil {
            // Nothing else reloads this page — neither the board refresh nor the ellipsis "刷新" —
            // so without a retry it stays offline until the route is popped and re-entered.
            HStack(spacing: 8) {
                Text(L10n.tr("离线，暂时读不到已完成的任务"))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                Button(L10n.tr("重试")) { model.loadCompleted(reset: true) }
                    .controlSize(.small).disabled(model.isLoadingCompleted)
            }
            .padding(.horizontal, 4).padding(.vertical, 10)
        } else {
            EmptyStateView(text: L10n.tr("还没有完成的任务\n完成一件，这里就会记下来。"), systemImage: "checkmark")
        }
    }

    @ViewBuilder private var footer: some View {
        // Searching filters only what has been loaded, so say so rather than implying the whole
        // history was searched.
        if searching, model.completedHasMore {
            Text(L10n.tr("只搜索了已加载的 \(model.completedTasks.count) 件"))
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .padding(.horizontal, 4).padding(.top, 4)
        }
        if model.completedLoadFailed {
            // A failure with rows already on screen is otherwise indistinguishable from "nothing
            // happened": the spinner blinks and the button comes back unchanged.
            HStack(spacing: 8) {
                Text(L10n.tr("加载失败")).font(.system(size: 11)).foregroundStyle(Theme.overdue)
                Button(L10n.tr("重试")) { model.loadCompleted() }
                    .controlSize(.small).disabled(model.isLoadingCompleted)
            }
            .frame(maxWidth: .infinity).padding(.top, 6)
        } else if model.completedHasMore {
            Button(action: model.loadMoreCompleted) {
                if model.isLoadingCompleted { ProgressView().controlSize(.small) }
                else { Text(L10n.tr("加载更早")) }
            }
            .buttonStyle(CueButtonStyle())
            .disabled(model.isLoadingCompleted)
            .frame(maxWidth: .infinity)
            .padding(.top, 6)
        } else if model.completedTasks.count >= CompletedHistory.maxWindow {
            Text(L10n.tr("已到可查看的上限，最近 \(CompletedHistory.maxWindow) 件"))
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity).padding(.top, 6)
        }
    }
}

/// The search row from the All tab, lifted so both surfaces stay identical.
struct SearchField: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @Binding var query: String
    let placeholder: String
    /// The placeholder often names the fields searched; the label stays a short name.
    var label: String? = nil

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(placeholder, text: $query).textFieldStyle(.plain)
                .accessibilityLabel(label ?? placeholder)
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain).accessibilityLabel(L10n.tr("清除搜索"))
            }
        }
        .font(.system(size: 12)).padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
    }
}
