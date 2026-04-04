# Session Notes - Mermaid Integration Fix

## COMPLETED Changes  
1. **web/app.js lines 5-18**: JSON parse with try/catch + recovery that ESCAPES control chars as `\uXXXX` (not strips)
2. **web/app.js lines 20-58**: Mermaid loading - removed dynamic script creation, uses event listener for `mermaid-loaded`
3. **web/app.js lines 135-162**: DOMPurify sanitizeHtml - STRICT config (no SVG/KaTeX/style) 
4. **web/app.js lines 164-245**: renderMarkdown - TRUSTED_BLOCK placeholder pattern, mermaid/KaTeX bypass DOMPurify
5. **web/index.html lines 14-17**: Added `<script type="module">` in head to load beautiful-mermaid
6. **web/app.js ~line 1480**: Fixed `data.projectName.toUpperCase()` → `(data.projectName || "").toUpperCase()`

## REMAINING - Workspace Issues
- User says: "workspaces are not loaded until clicked on open workspace"  
- User says: "hidden workspaces are not retained across sessions"

### Workspace Architecture (from code analysis):
- **renderProjectTree()** (~line 380-467): Renders sidebar with current workspace threads + other workspaces
- **data.workspaces**: Array from backend with workspace info
- **state.hiddenWorkspaces**: Loaded from `data.hiddenWorkspaces` at init (line 81)
- **Hide action** (line 525): Sets `state.hiddenWorkspaces[dirName] = true`, sends `set-hidden-workspaces` to backend
- **Show action** (line 673-679): Deletes from hiddenWorkspaces, sends to backend  
- **renderHiddenWorkspacesBar()** (line 599): Shows hidden workspaces in a collapsible bar
- **showWorkspaceModal()** (line 1338): Opens workspace picker modal
- **Backend handling**: Need to check index.ts for "set-hidden-workspaces" message handler

### Key Lines to Check:
- Line 81: `hiddenWorkspaces: (data.hiddenWorkspaces || {})`
- Line 525: Hide workspace action  
- Line 679: `send({ type: "set-hidden-workspaces", hiddenWorkspaces: state.hiddenWorkspaces })`
- index.ts: Search for "set-hidden-workspaces" handler and hiddenWorkspaces persistence

## Key Files
- c:\Users\Jagtprit\.pi\agent\git\github.com\pvjagtap\pi-desktop-ui\index.ts
- c:\Users\Jagtprit\.pi\agent\git\github.com\pvjagtap\pi-desktop-ui\web\app.js (~2200 lines)
- c:\Users\Jagtprit\.pi\agent\git\github.com\pvjagtap\pi-desktop-ui\web\index.html (~565 lines)
