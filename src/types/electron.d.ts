/** XNOWPost Electron IPC API types */

interface UpdateInfo {
  version: string
  releaseDate?: string
}

interface UpdateProgress {
  bytesPerSecond: number
  percent: number
  total: number
  transferred: number
}

interface LogEntry {
  time: string
  type: 'info' | 'success' | 'error' | 'warning'
  message: string
}

interface PublishItem {
  date: string; session: string; path: string
  type: string; title: string; time: string
}

interface EngineStatus {
  configured: boolean
  running: boolean
  todayDir: string
  schedulerRunning?: boolean
  schedulerActive?: boolean
  schedulerLastRun?: string
  recentErrors?: number
}

interface ConfigData {
  deepseekApiKey: string
  siliconflowApiKey: string
  pexelsApiKey: string
  tgBotToken: string
  tgChannelId: string
  cdpEndpoint: string
  bitApiKey?: string
  dataDir?: string  // 自定义数据存储目录
  accounts?: Array<{
    name: string
    platform: string
    bitEnvId: string
  }>
  [key: string]: unknown
}

interface ApiResult {
  ok: boolean
  message?: string
  list?: Array<{ id: string; name: string }>
  envId?: string
  published?: number
}

interface CostData {
  deepseek?: number
  kolors?: number
  total?: number
}

interface SessionDetail {
  text: string
  images: Array<{ name: string; data: string }>
  videoFile: boolean
  cost: CostData | null
}

interface HistoryGroup {
  date: string
  items: Array<{
    id: string
    title_zh: string
    type: 'video' | 'post' | 'unknown'
    status: string
    time: string
    dir: string
    date: string
    session: string
    thumbnail?: string
  }>
}

interface CollectData {
  date: string
  platforms: Record<string, Record<string, number>>
}

interface ReportData {
  date: string
  yesterday: string
  availableDates: string[]
  accounts: Record<string, Record<string, { stats: Record<string, number>; yesterday: Record<string, number> }>>
  accountMeta: Record<string, { platform: string; username: string; profileUrl: string }>
  collectedAt: string
}

interface XnowpostAPI {
  readonly isDev: boolean

  ping(): Promise<{ ok: boolean; time: number }>

  getConfig(): Promise<ConfigData>
  saveConfig(config: ConfigData): Promise<ApiResult>
  testApi(type: string, key: string): Promise<ApiResult>
  testBit(apiKey?: string): Promise<ApiResult>
  getDataDir(): Promise<{ path: string }>
  selectDataDir(): Promise<ApiResult & { path?: string }>
  migrateData(newDir: string): Promise<ApiResult & { needsRestart?: boolean }>

  runEngine(mode: string, topic?: string): Promise<ApiResult>
  cancelEngine(): Promise<ApiResult>
  getEngineStatus(): Promise<EngineStatus>

  getLogs(): Promise<LogEntry[]>
  getLogsByDate(date: string): Promise<LogEntry[]>
  clearLogs(): Promise<ApiResult>
  onLog(callback: (entry: LogEntry) => void): () => void

  getHistory(): Promise<HistoryGroup[]>
  readSession(dir: string): Promise<SessionDetail | null>
  getThumbnail(dir: string): Promise<string | null>
  openOutputDir(): void
  openExternal(url: string): Promise<ApiResult>

  getLatestCost(): Promise<CostData | null>

  runCollect(accounts?: string[]): Promise<ApiResult>
  getLatestCollect(): Promise<CollectData | null>
  getDailyReport(date?: string): Promise<ReportData | null>
  getTrend(days?: number): Promise<Record<string, { account: string; platform: string; metric: string; dates: string[]; values: (number|null)[] }> | null>
  pushReport(date?: string): Promise<ApiResult>

  checkUpdate(): void
  downloadUpdate(): void
  installUpdate(): void
  onUpdateAvailable(callback: (info: UpdateInfo) => void): () => void
  onUpdateNotAvailable(callback: () => void): () => void
  onUpdateProgress(callback: (progress: UpdateProgress) => void): () => void
  onUpdateDownloaded(callback: () => void): () => void
  onUpdateError(callback: (message: string) => void): () => void
  onProgress(callback: (progress: { step: string; label: string; percent: number }) => void): () => void
  onEngineStatusPush(callback: (status: EngineStatus) => void): () => void

  getSchedules(): Promise<Array<Record<string, unknown>>>
  saveSchedules(jobs: Array<Record<string, unknown>>): Promise<ApiResult>

  runPublish(): Promise<ApiResult>
  exportCsv(content: string, name?: string): Promise<ApiResult>
  getPendingPublish(): Promise<Array<{
    date: string; session: string; path: string;
    type: string; title: string; time: string
  }>>
  restartApp(): void
}

export {}

declare global {
  interface Window {
    xnowpost: XnowpostAPI
  }
}
