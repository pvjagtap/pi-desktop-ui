# Pi Desktop UI — Architecture Diagrams

## 1. Extension Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Registered: pi loads extension
    Registered --> SessionStart: session_start event
    SessionStart --> FooterEnabled: enableFooter()
    FooterEnabled --> WidgetEnabled: enableWidget()
    WidgetEnabled --> Ready: setStatus("desktop")

    state Ready {
        [*] --> Idle
        Idle --> WindowOpen: Ctrl+Alt+N / /desktop / /nav / --desktop flag
        WindowOpen --> Idle: window closed
        WindowOpen --> WindowOpen: session_start (reload/new/resume/fork)
    }

    Ready --> Shutdown: session_shutdown
    Shutdown --> [*]: closeActiveWindow()
```

## 2. High-Level Architecture

```mermaid
graph TB
    subgraph Terminal["Pi Terminal - TUI"]
        PiAgent["Pi Agent Core"]
        Footer["Custom Footer"]
        Widget["Context Widget"]
        Status["Status Bar"]
    end

    subgraph Extension["index.ts Extension"]
        EventHandlers["Event Handlers"]
        WindowManager["Window Manager"]
        DataCollectors["Data Collectors"]
        Security["Security Layer"]
        CommandReg["Command Registration"]
        HTMLBuilder["HTML Builder"]
    end

    subgraph DesktopWindow["Glimpse Native Window"]
        IndexHTML["web/index.html"]
        Sidebar["Sidebar Navigation"]
        ChatView["Chat View"]
        ExplorerView["File Explorer"]
        SkillsView["Skills View"]
        SettingsView["Settings View"]
        WorkspaceView["Workspace View"]
        DiffOverlay["Diff Overlay"]
        CommandPalette["Command Palette"]
        StreamingUI["Streaming UI"]
    end

    PiAgent -->|"pi.on() events"| EventHandlers
    EventHandlers -->|"sendToWindow()"| WindowManager
    WindowManager -->|"glimpse.send(js)"| DesktopWindow
    DesktopWindow -->|"glimpse.on(message)"| WindowManager
    WindowManager -->|"handleWindowMessage()"| DataCollectors
    DataCollectors -->|"sendToWindow()"| WindowManager
    CommandReg -->|"registerCommand"| PiAgent
    HTMLBuilder -->|"buildDesktopHtml()"| WindowManager
    Extension --> Footer
    Extension --> Widget
    Extension --> Status
    Security -.->|validates| DataCollectors
```

## 3. Message Streaming Flow

```mermaid
sequenceDiagram
    participant User as User (Terminal or Window)
    participant Pi as Pi Agent
    participant Ext as Extension (index.ts)
    participant Win as Desktop Window (app.js)

    User->>Win: Types message + Enter
    Win->>Ext: { type: "send-message", text }
    Ext->>Pi: pi.sendUserMessage(text)

    Pi->>Ext: agent_start event
    Ext->>Win: { type: "agent-start" }
    Note over Win: Show waiting indicator

    Pi->>Ext: message_start (assistant)
    Ext->>Win: { type: "message-start" }

    loop Thinking (optional)
        Pi->>Ext: message_update (thinking_start)
        Ext->>Win: { type: "thinking-start" }
        Pi->>Ext: message_update (thinking_delta)
        Ext->>Win: { type: "thinking-chunk", text }
        Pi->>Ext: message_update (thinking_end)
        Ext->>Win: { type: "thinking-end" }
    end

    loop Text streaming
        Pi->>Ext: message_update (text_start)
        Ext->>Win: { type: "message-chunk-start" }
        Pi->>Ext: message_update (text_delta)
        Ext->>Win: { type: "message-chunk", text }
        Pi->>Ext: message_update (text_end)
        Ext->>Win: { type: "message-chunk-end" }
    end

    Pi->>Ext: message_end (assistant)
    Ext->>Win: { type: "message-end", content }
    Note over Win: Append final message

    Pi->>Ext: agent_end event
    Ext->>Win: { type: "agent-end" }
    Ext->>Win: { type: "stats-update", stats }
    Note over Win: Update token stats
```

## 4. Tool Execution Flow

```mermaid
sequenceDiagram
    participant Pi as Pi Agent
    participant Ext as Extension
    participant Win as Desktop Window

    Pi->>Ext: tool_execution_start
    Note over Ext: Format args display<br/>(bash→command, read→path,<br/>edit→diffs as base64)

    alt Plan Mode Active & Write Tool
        Ext->>Win: { type: "plan-mode-violation" }
        Note over Win: Show warning toast
    end

    Ext->>Win: { type: "tool-start", toolName,<br/>toolCallId, argsDisplay,<br/>editDiffsB64, editPath }
    Note over Win: Show spinner + tool card

    Pi->>Ext: tool_execution_end
    Ext->>Win: { type: "tool-end", toolCallId,<br/>isError, resultText }
    Note over Win: Update card in-place<br/>(preserves details open state)
```

## 5. Window ↔ Extension Communication Protocol

```mermaid
graph LR
    subgraph "Window → Extension Messages"
        SM["send-message"] --> |text| A1[pi.sendUserMessage]
        OT["open-thread"] --> |file| A2[extractThreadMessages]
        NAV["nav"] --> |action| A3[getDirEntries]
        ETE["explorer-tree-expand"] --> |path| A4[getDirEntries + validate]
        EO["explorer-open"] --> |path| A5[readFile / openApp]
        GC["get-commands"] --> A6[getAllCommands]
        GS["get-stats"] --> A7[getTokenStats]
        RT["refresh-threads"] --> A8[getSessionThreads]
        RS["refresh-skills"] --> A9[getSkills + getExtensions]
        GW["get-workspaces"] --> A10[getWorkspaces]
        GWS["get-workspace-sessions"] --> A11[getWorkspaceSessions]
        ST["search-threads"] --> A12[searchSessionThreads]
        OFP["open-folder-path"] --> A13[resolve + validate path]
        SPM["set-plan-mode"] --> A14[toggle planMode]
        AF["attach-file"] --> A15[write to tmp]
        CS["cancel-streaming"] --> A16[ctx.abort]
        SHW["set-hidden-workspaces"] --> A17[saveHiddenWorkspaces]
        CL["close"] --> A18[closeActiveWindow]
    end
```

```mermaid
graph LR
    subgraph "Extension → Window Messages"
        B1["agent-start / agent-end"]
        B2["message-start / chunk / end"]
        B3["thinking-start / chunk / end"]
        B4["tool-start / tool-end"]
        B5["stats-update"]
        B6["thread-messages"]
        B7["explorer-data / tree-children"]
        B8["file-content"]
        B9["commands-list"]
        B10["update-threads / update-skills"]
        B11["workspaces-list / workspace-sessions"]
        B12["search-results"]
        B13["workspace-opened"]
        B14["file-attached-ack"]
        B15["plan-mode-violation"]
        B16["session-changed"]
        B17["provider-request"]
    end
```

## 6. Sidebar Navigation State Machine

```mermaid
stateDiagram-v2
    [*] --> Threads: default view

    Threads --> Skills: click Skills nav
    Threads --> Settings: click Settings nav
    Threads --> Explorer: click Explorer nav
    Threads --> WorkspaceModal: click Open Workspace nav

    Skills --> Threads: click Threads nav
    Settings --> Threads: click Threads nav
    Explorer --> Threads: click Explorer tree back
    WorkspaceModal --> Threads: close modal

    state Threads {
        [*] --> CurrentSession
        CurrentSession --> OldThread: click thread in sidebar
        OldThread --> CurrentSession: Escape key
        CurrentSession --> SearchResults: type in search box
        SearchResults --> OldThread: click search result
        SearchResults --> CurrentSession: clear search
    }

    state Explorer {
        [*] --> FileTree
        FileTree --> FileViewer: click file
        FileViewer --> FileTree: Back button
        FileTree --> FileTree: expand/collapse dirs
    }

    state WorkspaceModal {
        [*] --> BrowseWorkspaces
        BrowseWorkspaces --> OpenFolder: enter path
        BrowseWorkspaces --> ExpandWorkspace: click workspace
    }
```

## 7. Data Flow on Window Open

```mermaid
flowchart TD
    A[openDesktopWindow called] --> B{window already open?}
    B -->|Yes| C[Notify warning & return]
    B -->|No| D[collectWindowData]

    D --> D1[getTokenStats]
    D --> D2[getSessionThreads]
    D --> D3[getSkills]
    D --> D4[getExtensions]
    D --> D5[getWorkspaces]
    D --> D6[extractSessionMessages]
    D --> D7[getDirEntries cwd]
    D --> D8[getAllCommands]
    D --> D9[loadHiddenWorkspaces]

    D1 & D2 & D3 & D4 & D5 & D6 & D7 & D8 & D9 --> E[buildDesktopHtml]

    E --> E1["Read index.html template"]
    E --> E2["Read app.js"]
    E --> E3["JSON.stringify data → Base64"]
    E1 & E2 & E3 --> E4["Replace __INLINE_DATA__ and __INLINE_JS__"]

    E4 --> F["glimpseui.open(html, opts)"]
    F --> G["Register event listeners:<br/>on('message') → handleWindowMessage<br/>on('closed') → cleanup<br/>on('error') → cleanup"]
    G --> H["Set hidden thinking label<br/>setHiddenThinkingLabel()"]
    H --> I[Window Ready — bidirectional sync active]
```

## 8. Security Model

```mermaid
flowchart TD
    subgraph Input["User Input Validation"]
        V1["Message length: max 100K chars"]
        V2["Search query: 2-200 chars"]
        V3["Attachment: max 25MB"]
        V4["Path: no '..' traversal"]
        V5["Filename: sanitized chars only"]
    end

    subgraph PathSec["Path Security"]
        P1["isPathAllowed():<br/>must be under cwd or<br/>~/.pi/agent/sessions/"]
        P2["isValidSessionFile():<br/>must end .jsonl +<br/>under sessions dir +<br/>no '..' in path"]
        P3["Workspace dirName:<br/>reject / \\ chars"]
        P4["open-folder-path:<br/>resolve + normalize +<br/>verify under sessions root"]
    end

    subgraph Output["Output Security"]
        O1["DOMPurify: strict tag allowlist"]
        O2["CSP: no connect-src,<br/>no object-src, no form-action"]
        O3["SRI: integrity hashes on CDN"]
        O4["escapeNonAscii():<br/>\\uXXXX encoding for<br/>Windows CP1252 safety"]
        O5["Base64 data transfer:<br/>survives webview bridge"]
    end

    Input --> PathSec
    PathSec --> Output
```
