export type AIProvider =
  | 'gemini'
  | 'openai'
  | 'deepseek'
  | 'grok'
  | 'moonshot'
  | 'custom-openai';

export type LegacyAIProvider = AIProvider | 'kimi';

export interface AIProfile {
  provider: AIProvider;
  baseUrl?: string;
  model: string;
  apiKey: string;
  name?: string;
  temperature?: number;
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type GatewayMode = 'chat' | 'agent' | 'autocomplete' | 'analysis';

export interface SkillMetadata {
  filename: string;
  name: string;
  description: string;
  tags: string[];
  trigger?: string;
  category: string;
  content: string;
  excerpt: string;
  size: number;
  isSystem: boolean;
  source: 'system' | 'imported' | 'user' | 'lsf' | 'donau' | 'cluster';
  sourcePath: string;
  score?: number;
  // New: skill relation fields from frontmatter
  dependsOn?: string[];
  relatedTo?: string[];
  usedWith?: string[];
  solves?: string[];
}

export interface SkillIndex {
  generatedAt: string;
  skills: SkillMetadata[];
}

export type SkillRelation = 'depends_on' | 'related_to' | 'used_with' | 'triggers' | 'solves';

export interface SkillEdge {
  from: string;
  to: string;
  relation: SkillRelation;
  weight: number;
  reason: string;
}

export interface SkillGraph {
  nodes: Map<string, SkillMetadata>;
  edges: SkillEdge[];
  adjacency: Map<string, SkillEdge[]>;
}

export type FileType = 'fastq' | 'fasta' | 'bam' | 'sam' | 'vcf' | 'gvcf' | 'bed' | 'gff' | 'gtf' | 'fa' | 'lsf' | 'sh' | 'html' | 'csv' | 'tsv' | 'png' | 'pdf' | 'r' | 'py' | 'directory' | 'other';

export interface FileEntry {
  name: string;
  size: number;
  modified: number;
  type: FileType;
  recognizedSkillHints: string[];
}

export interface JobEntry {
  jobId: string;
  name: string;
  status: 'RUN' | 'PEND' | 'DONE' | 'EXIT' | 'UNKNOWN';
  cores: number;
  queue: string;
  runtime: string;
}

export interface QuotaInfo {
  filesystem: string;
  used: string;
  total: string;
  percent: string;
}

export interface QueueInfo {
  name: string;
  slots: number;
  used: number;
  available: number;
}

export interface ClusterSnapshot {
  workingDir: string;
  files: FileEntry[];
  jobs: JobEntry[];
  quota: QuotaInfo | null;
  modules: string[];
  queueStatus: QueueInfo[];
  timestamp: number;
}

export type SnapshotDepth = 'standard' | 'full';

export interface ObservationEntry {
  id?: string;
  type: 'command' | 'output' | 'error' | 'warning' | 'state_change' | 'job_submit' | 'file_create';
  data: string;
  timestamp?: string;
  summary?: string;
  importance?: 1 | 2 | 3;
  relatedSkills?: string[];
  relatedFiles?: string[];
  command?: string;
  exitCode?: number;
  causalFrom?: string;
}

export interface ContextBuildOptions {
  messages: AIMessage[];
  mode?: GatewayMode;
  skillIndex?: SkillIndex;
  observations?: ObservationEntry[];
  memory?: string;
  summary?: string;
  terminalState?: string;
  selectedOutput?: string;
  maxSkillChars?: number;
  maxMessageChars?: number;
  sshSessionId?: string;
  skillGraph?: SkillGraph;
  structuredMemory?: StructuredMemory;
  taskPlan?: TaskPlan;
}

export interface GatewayRequest {
  profile: AIProfile;
  messages: AIMessage[];
  isFastMode?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StreamEvent {
  type: 'reasoning' | 'content' | 'done' | 'error' | 'tool_call' | 'tool_result' | 'step' | 'ask' | 'ask_done' | 'plan' | 'plan_update' | 'status' | 'compacted';
  content?: string;
  error?: string;
  name?: string;
  args?: unknown;
  result?: string;
  question?: string;
  phase?: string;
  message?: string;
  requestId?: string;
  /** ask 事件附带：给用户点选的候选答案按钮 */
  options?: string[];
  step?: number;
}

// Token Budget
export interface TokenAllocation {
  min: number;
  max: number;
  used: number;
  priority: number;
}

export interface TokenBudget {
  total: number;
  used: number;
  allocations: Map<string, TokenAllocation>;
}

// Skill Knowledge Pack
export interface SkillSnippet {
  skillFile: string;
  source?: SkillMetadata['source'];
  chapter?: string;
  content: string;
  tokenCount: number;
  relevanceScore: number;
}

export interface BibleChunk {
  chapter: string;
  content: string;
  tokenCount: number;
  relevanceScore: number;
}

export interface SkillKnowledgePack {
  core: SkillSnippet | null;
  dependencies: SkillSnippet[];
  related: SkillSnippet[];
  bible: BibleChunk[];
  totalTokens: number;
}

// Memory
export interface KeyFact {
  category: 'environment' | 'data' | 'method' | 'result' | 'preference';
  fact: string;
  timestamp: number;
}

export interface Decision {
  what: string;
  why: string;
}

export interface ErrorRecord {
  error: string;
  resolution: string;
}

export interface StructuredMemory {
  task: string;
  progress: {
    phase: number;
    description: string;
    completed: number;
    total?: number;
  };
  keyFacts: KeyFact[];
  decisions: Decision[];
  skillsUsed: string[];
  errors: ErrorRecord[];
  generatedAt: number;
}

export interface ConversationWithMemory {
  messages?: AIMessage[];
  summary?: string;
  memory?: string;
  skillHints?: string[];
  structuredMemory?: StructuredMemory;
  [key: string]: any;
}

// Agent Planner
export interface Step {
  id: string;
  description: string;
  command?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
  linkedSkills: string[];
  jobId?: string;
}

export interface Phase {
  id: number;
  name: string;
  status: 'pending' | 'active' | 'done' | 'failed';
  steps: Step[];
  linkedSkills: string[];
  entryConditions: string[];
}

export interface TaskPlan {
  goal: string;
  phases: Phase[];
  currentPhase: number;
  createdAt: number;
}
