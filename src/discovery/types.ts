export interface AgentRosterEntry {
  name: string;
  path: string;
}

export interface AgentRoster {
  root: string;
  agents: AgentRosterEntry[];
  scannedEntries: number;
  truncated: boolean;
}

export interface AgentDiscoveryOptions {
  maxAgents?: number;
  maxScannedEntries?: number;
}
