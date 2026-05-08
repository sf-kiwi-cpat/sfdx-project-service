export type GovernanceUser = {
  id: string;
  name: string;
  email: string;
};

export type GovernanceCurrentUser = {
  id: string;
  name: string;
  username: string;
  roleLabel: string;
};

export type GovernanceAsset = {
  id: string;
  name: string;
  apiName: string;
  type: string;
  department: string;
  ownerUserId: string | null;
  ownerName: string | null;
  status: 'Healthy' | 'Stale' | 'Duplicate' | 'NeedsReview';
  healthScore: number;
  riskLevel: string | null;
  staleDays: number | null;
  sourceSystem: string | null;
};

export type GovernanceTask = {
  id: string;
  title: string;
  ownerUserId: string | null;
  ownerName: string;
  dueDate: string | null;
  dueLabel: string;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  status: string;
  taskType: string;
  recommendedAction: string | null;
  assetId: string | null;
  assetName: string | null;
};

export type GovernanceEventLog = {
  id: string;
  title: string;
  details: string;
  timeLabel: string;
  badge: string;
  tone: 'neutral' | 'danger' | 'accent';
};

export type GovernanceBootstrap = {
  currentUser: GovernanceCurrentUser;
  users: GovernanceUser[];
  assets: GovernanceAsset[];
  tasks: GovernanceTask[];
  eventLogs: GovernanceEventLog[];
};

export type GovernanceImportedAsset = {
  externalKey: string;
  name: string;
  apiName: string;
  assetType: string;
  department: string;
  healthStatus: string;
  healthScore: number;
  riskLevel: string;
  sourceSystem: string;
  stewardshipNotes: string;
  staleDays?: number | null;
  lastUsedOn?: string | null;
  lastAttestedOn?: string | null;
};

export type GovernanceImportResponse = {
  importedCount: number;
  createdCount: number;
  updatedCount: number;
};

type DataSdk = {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
};

let dataSdkPromise: Promise<DataSdk> | null = null;

function isSalesforceHost() {
  if (typeof window === 'undefined') {
    return false;
  }

  const hostname = window.location.hostname;
  // localhost is the only environment where there's no Salesforce proxy
  // intercepting /services/* calls (npm-run-dev outside of preview-service).
  // Every other host — real org, code-builder, App Studio preview-service —
  // forwards via the @salesforce/vite-plugin-ui-bundle proxy or by being
  // served by Lightning itself, so /services/apexrest paths work directly.
  return hostname !== 'localhost' && hostname !== '127.0.0.1';
}

function getGovernanceApiBase() {
  // Anchor against Vite's BASE_URL so the request lands inside the
  // preview's `/preview/<id>/` route — the only path nginx forwards to
  // preview-service, where the ui-bundle proxy can intercept.
  const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
  if (isSalesforceHost()) {
    return `${base}/services/apexrest/data-curator/v1`;
  }
  return `${base}/api/governance`;
}

async function getDataSdk() {
  if (!dataSdkPromise) {
    dataSdkPromise = import('@salesforce/sdk-data').then(async ({ createDataSDK }) => {
      const sdk = await createDataSDK();
      return sdk as DataSdk;
    });
  }

  return dataSdkPromise;
}

async function governanceFetch(path: string, init?: RequestInit) {
  const url = `${getGovernanceApiBase()}${path}`;

  if (!isSalesforceHost()) {
    return fetch(url, {
      credentials: 'same-origin',
      ...init,
    });
  }

  const sdk = await getDataSdk();
  return sdk.fetch(url, init);
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & {
    error?: string;
    details?: unknown;
  };

  if (!response.ok) {
    throw new Error(payload.error ?? 'Governance API request failed.');
  }

  return payload;
}

async function postJson<T>(path: string, body: unknown) {
  const response = await governanceFetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return readJson<T>(response);
}

export async function fetchGovernanceBootstrap() {
  const response = await governanceFetch('/bootstrap');
  return readJson<GovernanceBootstrap>(response);
}

export async function createGovernanceAsset(payload: {
  name: string;
  assetType: string;
  department: string;
  ownerUserId?: string | null;
  healthStatus: string;
}) {
  return postJson<GovernanceBootstrap>('/assets', payload);
}

export async function createGovernanceTask(payload: {
  title: string;
  ownerUserId?: string | null;
  dueDate?: string | null;
  priority: string;
  taskType?: string;
  recommendedAction?: string;
  metadataAssetId?: string | null;
}) {
  return postJson<GovernanceBootstrap>('/tasks', payload);
}

export async function assignGovernanceOwner(payload: { assetId: string; ownerUserId: string }) {
  return postJson<GovernanceBootstrap>('/actions/assign-owner', payload);
}

export async function runGovernanceFullScan() {
  return postJson<GovernanceBootstrap>('/actions/full-scan', {});
}

export async function runGovernanceStaleReview(payload?: {
  departmentFilter?: string;
  staleThresholdDays?: number;
}) {
  return postJson<GovernanceBootstrap>('/actions/stale-review', payload ?? {});
}

export async function runGovernanceBulkAction(payload: {
  assetIds: string[];
  action: 'assign_owner' | 'create_task' | 'mark_healthy';
  ownerUserId?: string | null;
  taskTitle?: string;
  taskPriority?: string;
}) {
  return postJson<GovernanceBootstrap>('/actions/bulk', payload);
}

export async function recordGovernanceExport(payload: {
  format: 'csv' | 'pdf';
  rowCount: number;
  department: string;
  type: string;
  status: string;
  ownership: string;
}) {
  return postJson<GovernanceBootstrap>('/actions/export', payload);
}

export async function importGovernanceAssets(payload: { assets: GovernanceImportedAsset[] }) {
  return postJson<GovernanceImportResponse>('/actions/import-assets', payload);
}
