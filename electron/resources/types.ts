export type SupportedPlatform = 'windows' | 'macos';
export type SupportedArch = 'x64' | 'arm64';
export type InstallModeTag = 'core' | 'full' | 'online-bootstrap' | 'importable';
export type ResourceType =
  | 'launcher'
  | 'node'
  | 'runtime'
  | 'rootfs'
  | 'gateway-bundle'
  | 'manifest'
  | 'checksum'
  | 'repair-bundle'
  | 'plugin-pack';

export type ResourceSourceKind = 'official' | 'mirror-cn' | 'custom' | 'lan' | 'local-import';

export interface ResourceSource {
  type: ResourceSourceKind;
  url?: string;
  path?: string;
  priority?: number;
  enabled?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  description?: string;
}

export interface InstallHints {
  extractDir?: string;
  executablePath?: string;
  checksumFile?: string;
  postInstallNotes?: string[];
  repairStrategy?: 'redownload' | 'reimport' | 'manual';
}

export interface ResourceDependency {
  resourceId: string;
  reason?: string;
}

export interface ResourceDefinition {
  id: string;
  name: string;
  version: string;
  platform: SupportedPlatform;
  arch: SupportedArch;
  resourceType: ResourceType;
  modeTags: InstallModeTag[];
  size: number;
  sha256: string;
  filename: string;
  relativePath: string;
  sources: ResourceSource[];
  installHints: InstallHints;
  dependencies: ResourceDependency[];
  optional: boolean;
  description: string;
}

export interface ResourceBundle {
  id: string;
  name: string;
  version: string;
  platform: SupportedPlatform;
  arch: SupportedArch;
  mode: InstallModeTag;
  resourceIds: string[];
  description?: string;
}

export interface CompatibilityRange {
  minLauncherVersion?: string;
  maxLauncherVersion?: string;
  supportedPlatforms?: SupportedPlatform[];
  supportedArchitectures?: SupportedArch[];
}

export interface ResourceManifest {
  schemaVersion: string;
  productVersion: string;
  generatedAt: string;
  compatibilityRange: CompatibilityRange;
  defaultSourcePriority: ResourceSourceKind[];
  resources: ResourceDefinition[];
  bundles: ResourceBundle[];
}

export interface ResourceMatrixRow {
  platform: SupportedPlatform;
  arch: SupportedArch;
  supportedModes: InstallModeTag[];
  defaultBundleId: string;
  notes?: string[];
}

export interface ResourceValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ResourceVerificationResult {
  resourceId: string;
  exists: boolean;
  valid: boolean;
  path?: string;
  sha256?: string;
  reason?: string;
}

export interface ResourceResolveRequest {
  mode: InstallModeTag;
  platform: SupportedPlatform;
  arch: SupportedArch;
  bundleId?: string;
}

export interface ResolvedResourceSet {
  bundle: ResourceBundle | null;
  resources: ResourceDefinition[];
  missingDependencies: string[];
}

export interface ManifestLoadOptions {
  localPath?: string;
  remoteUrl?: string;
  sourcePriority?: ResourceSourceKind[];
}

export interface DownloadQueueItem {
  resource: ResourceDefinition;
  destinationPath: string;
}

export interface DownloadProgress {
  resourceId: string;
  file?: string;
  transferredBytes?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  percentage?: number;
  source?: string;
  retryCount?: number;
}

export interface DownloadAttemptResult {
  resourceId: string;
  success: boolean;
  source?: string;
  destinationPath: string;
  error?: string;
  attempts: number;
  verified?: boolean;
  fromCache?: boolean;
}

export interface CachedResourceRecord {
  resourceId: string;
  version: string;
  platform: SupportedPlatform;
  arch: SupportedArch;
  filePath: string;
  sha256: string;
  size: number;
  cachedAt: string;
}

export interface LocalImportCandidate {
  manifestPath: string;
  manifest: ResourceManifest;
  resources: ResourceDefinition[];
}
