import SwiftUI
import AppKit

struct ActivityEntry: Identifiable, Codable {
    var id = UUID()
    var app: String
    var seconds: TimeInterval
}

@MainActor final class ActivityStore: ObservableObject {
    @Published var entries: [ActivityEntry] = []
    @Published var tracking = false
    private var timer: Timer?
    private let key = "VibeFriend.activity.v1"
    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let saved = try? JSONDecoder().decode([ActivityEntry].self, from: data) { entries = saved }
    }
    func start() {
        guard !tracking else { return }
        tracking = true
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }
    func stop() { timer?.invalidate(); timer = nil; tracking = false }
    private func tick() {
        guard let app = NSWorkspace.shared.frontmostApplication?.localizedName,
              app != "VibeFriend" else { return }
        if let index = entries.firstIndex(where: { $0.app == app }) { entries[index].seconds += 1 }
        else { entries.append(ActivityEntry(app: app, seconds: 1)) }
        if let data = try? JSONEncoder().encode(entries) { UserDefaults.standard.set(data, forKey: key) }
    }
    func exportCSV() -> String {
        let rows = entries.sorted { $0.seconds > $1.seconds }.map {
            "\"\($0.app.replacingOccurrences(of: "\"", with: "\"\""))\",\(Int($0.seconds))"
        }
        return (["application,seconds"] + rows).joined(separator: "\n")
    }
    func export() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "VibeFriend-activity.csv"
        panel.allowedContentTypes = [.commaSeparatedText]
        if panel.runModal() == .OK, let url = panel.url {
            try? exportCSV().write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

struct Dashboard: View {
    @StateObject private var store = ActivityStore()
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("VibeFriend").font(.largeTitle.bold())
            Text("Private, on-device app usage tracking").foregroundStyle(.secondary)
            HStack {
                Button(store.tracking ? "Pause tracking" : "Start tracking") {
                    if store.tracking { store.stop() } else { store.start() }
                }
                Button("Export CSV") { store.export() }
            }
            List(store.entries.sorted { $0.seconds > $1.seconds }) { entry in
                HStack {
                    Text(entry.app)
                    Spacer()
                    Text(Duration.seconds(entry.seconds).formatted())
                        .monospacedDigit().foregroundStyle(.secondary)
                }
            }
            Text("Tracks application names only. No screenshots, keystrokes, or cloud uploads.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(24).frame(minWidth: 560, minHeight: 420)
    }
}

@main struct VibeFriendApp: App {
    var body: some Scene { WindowGroup { Dashboard() } }
}
