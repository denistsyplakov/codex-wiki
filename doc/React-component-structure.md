Component tree for `client/src/components`:

- `client/src/components/AIChat.tsx` - floating AI assistant panel with message history, streaming responses, and configurable model/account selection
- `client/src/components/Attachments.tsx` - modal dialog for uploading, downloading, deleting, and inserting file attachments scoped to a folder
- `client/src/components/Editor.tsx` - markdown text editor for creating and updating wiki pages, including toolbar shortcuts and access to version history and attachments
- `client/src/components/ErrorBoundary.tsx` - React class component that catches runtime rendering errors and displays a fallback error message
- `client/src/components/FolderTree.tsx` - collapsible folder hierarchy tree rendered in the sidebar for navigating between wiki folders
- `client/src/components/Login.tsx` - password entry form shown before the app is accessible; calls the auth API and delegates success to the parent
- `client/src/components/PageList.tsx` - sortable list of pages inside the currently selected folder, with controls to create and delete pages
- `client/src/components/Preview.tsx` - read-only markdown renderer with syntax-highlighted code blocks, Mermaid diagram support, and an embedded table of contents
- `client/src/components/Search.tsx` - full-text search modal triggered by Ctrl+K / Cmd+K; shows ranked results and navigates to the selected page
- `client/src/components/TableOfContents.tsx` - collapsible dropdown extracted from the current document's headings with scroll-spy active-heading tracking
- `client/src/components/VersionHistory.tsx` - modal showing the git commit log for a page with side-by-side diff comparison and a one-click restore action
