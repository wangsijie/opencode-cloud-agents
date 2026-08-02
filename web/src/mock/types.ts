import type {
  AgentSessionEntry,
  QuestionRequest,
  SessionChanges,
  SessionMessage,
  SessionView
} from '../api';

/** A file (or symlink target) in the fixture workspace tree. */
export interface MockWorkspaceFileNode {
  type: 'file' | 'symlink';
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  /** Defaults to the content's byte length. */
  size?: number;
}

export interface MockWorkspaceDir {
  type: 'dir';
  /** Renders the "listing the first 2000" note. */
  truncated?: boolean;
  entries: Record<string, MockWorkspaceNode>;
}

export type MockWorkspaceNode = MockWorkspaceDir | MockWorkspaceFileNode;

/** Everything the mock backend knows about one session. */
export interface MockSessionState {
  view: SessionView;
  transcript: SessionMessage[];
  /** Served as the mirror timestamp on non-attached reads. */
  mirroredAt?: string;
  childTranscripts: Record<string, SessionMessage[]>;
  lineages: Record<string, AgentSessionEntry[]>;
  changes?: SessionChanges;
  workspace?: MockWorkspaceDir;
  /** Question requests waiting on the reader, matched to parts by callID. */
  pendingQuestions?: QuestionRequest[];
}
