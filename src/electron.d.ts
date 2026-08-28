export {}

type AiSettingsStatus = { model: 'deepseek-chat' | 'deepseek-reasoner'; autoWrite: boolean; confirmBeforeWrite: boolean; allowWorkspaceCommands: boolean; apiKeyConfigured: boolean; doubaoSearchKeyConfigured: boolean; encryptionAvailable: boolean; workspaceOpen: boolean }
type AiChatMessage = { role: 'user' | 'assistant'; content: string }
type AiChatResult = { text: string; writes: string[]; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null; model: string }

declare global {
  type WorkspaceEntry = { name: string; path: string; type: 'directory' | 'file'; children?: WorkspaceEntry[] }
  type WorkspaceSearchResult = { path: string; relativePath: string; line: number; text: string }
  type GitStatus = { branch: string; changes: { status: string; path: string }[] }
  interface Window {
    workspace?: { choose: () => Promise<{ root: string; name: string; tree: WorkspaceEntry[] } | null>; createManaged: () => Promise<{ root: string; name: string; tree: WorkspaceEntry[] }>; refreshTree: () => Promise<WorkspaceEntry[]>; read: (filePath: string) => Promise<string>; write: (filePath: string, content: string) => Promise<boolean>; search: (query: string, maxResults?: number) => Promise<WorkspaceSearchResult[]>; gitStatus: () => Promise<GitStatus>; gitDiff: (filePath?: string) => Promise<string> }
    ai?: { status: () => Promise<AiSettingsStatus>; saveSettings: (settings: { apiKey?: string; doubaoSearchKey?: string; model?: 'deepseek-chat' | 'deepseek-reasoner'; autoWrite?: boolean; confirmBeforeWrite?: boolean; allowWorkspaceCommands?: boolean; clearKey?: boolean; clearDoubaoSearchKey?: boolean }) => Promise<AiSettingsStatus>; chat: (messages: AiChatMessage[], sessionType?: 'project' | 'standalone', sessionKey?: string) => Promise<AiChatResult> }
    aiProgress?: { onProgress: (callback: (progress: { sessionKey: string; message: string }) => void) => () => void }
    aiStream?: { onChunk: (callback: (chunk: { sessionKey: string; content?: string; reset?: boolean }) => void) => () => void }
    aiActivity?: { onActivity: (callback: (activity: { sessionKey: string; id: string; title: string; detail: string; status: 'pending' | 'running' | 'done' | 'error'; kind?: 'plan' | 'execution' }) => void) => () => void }
  }
}
