export type CloudTask = {
  id: string;
  title: string;
  status: string;
  /** The claude.ai page for the session. */
  url: string;
  /** For a session waiting on you: the tool it wants approved. */
  pendingTool: string | null;
};

export type CloudSnapshot = {
  tasks: CloudTask[];
  error: string | null;
  checkedAt: number;
};

declare module 'claude-code' {
  interface PluginState {
    pulse: { snapshot: CloudSnapshot | null; isHidden: boolean };
  }
}
