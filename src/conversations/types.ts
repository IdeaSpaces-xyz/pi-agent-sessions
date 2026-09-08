export interface ConversationCatalogLimits {
  maxConversations: number;
  maxScannedEntries: number;
  maxFileBytes: number;
  maxPreviewChars: number;
  maxQueryChars: number;
}

export interface AgentConversation {
  conversationId: string;
  name?: string;
  firstMessage: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
}

export interface AgentConversationCatalog {
  agent: string;
  conversations: AgentConversation[];
  scannedEntries: number;
  skippedEntries: number;
  truncated: boolean;
}

export interface ConversationCatalogOptions {
  query?: string;
  limits?: Partial<ConversationCatalogLimits>;
  agentDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}
