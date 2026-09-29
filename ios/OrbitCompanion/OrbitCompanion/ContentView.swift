import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var client: OrbitAPIClient
    @State private var email = ""
    @State private var password = ""
    @State private var title = ""
    @State private var prompt = ""

    var body: some View {
        NavigationStack {
            Group {
                if client.user == nil { loginView }
                else { dashboard }
            }
            .navigationTitle("Orbit Companion")
            .overlay { if client.isBusy { ProgressView().controlSize(.large) } }
            .task { if client.user == nil { await client.restoreSession() } }
        }
    }

    private var loginView: some View {
        Form {
            Section("Your server") {
                TextField("https://orbit.example.com", text: $client.serverAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
            }
            Section("Account") {
                TextField("Email", text: $email).textInputAutocapitalization(.never).keyboardType(.emailAddress)
                SecureField("Password", text: $password)
                Button("Sign in") { Task { await client.login(email: email, password: password) } }
                    .disabled(email.isEmpty || password.isEmpty || client.isBusy)
            }
            errorSection
            Section { Text("Create accounts and manage recovery codes in the installed Orbit web app.").font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private var dashboard: some View {
        List {
            Section {
                LabeledContent("Server", value: client.status?.buddyName ?? "Orbit")
                LabeledContent("Version", value: client.status?.version ?? "—")
                LabeledContent("State", value: client.status?.paused == true ? "Paused" : "Running")
            }
            Section("New internal task") {
                TextField("Title", text: $title)
                TextField("What should Orbit prepare?", text: $prompt, axis: .vertical).lineLimit(3...7)
                Button("Send to Orbit") {
                    let savedTitle = title, savedPrompt = prompt
                    title = ""; prompt = ""
                    Task { await client.createTask(title: savedTitle, prompt: savedPrompt) }
                }.disabled(title.isEmpty || prompt.isEmpty || client.status?.paused == true)
            }
            Section("Recent tasks") {
                if client.tasks.isEmpty { Text("No tasks yet.").foregroundStyle(.secondary) }
                ForEach(client.tasks.prefix(20)) { task in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title).font(.headline)
                        Text(task.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if client.user?.role == "owner" {
                Section("Emergency control") {
                    if client.status?.paused == true {
                        Button("Resume Orbit") { Task { await client.resume() } }
                    } else {
                        Button("Emergency pause", role: .destructive) { Task { await client.pause() } }
                    }
                }
            }
            errorSection
        }
        .refreshable { await client.refresh() }
    }

    @ViewBuilder private var errorSection: some View {
        if !client.message.isEmpty { Section { Text(client.message).foregroundStyle(.red) } }
    }
}
