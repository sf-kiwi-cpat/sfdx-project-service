import { createDataSDK } from '@salesforce/sdk-data';
import type { GovernanceImportedAsset } from './governanceApi';

type DataSdk = {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
};

type QueryResponse<T> = {
  records: T[];
  nextRecordsUrl?: string;
  done?: boolean;
};

type EntityDefinitionRecord = {
  QualifiedApiName: string;
  Label?: string | null;
  DurableId: string;
};

type FieldDefinitionRecord = {
  QualifiedApiName: string;
  DurableId: string;
  DataType?: string | null;
  EntityDefinition?: {
    QualifiedApiName: string;
  };
};

type FlowDefinitionViewRecord = {
  ApiName: string;
  Label?: string | null;
};

type FlowRecord = {
  ProcessType?: string | null;
  Status?: string | null;
  VersionNumber?: number | null;
  Definition?: {
    DeveloperName?: string | null;
  };
};

type ApexClassRecord = {
  Name: string;
  ApiVersion?: number | null;
  Status?: string | null;
  NamespacePrefix?: string | null;
};

type PermissionSetRecord = {
  Id: string;
  Name: string;
  Label?: string | null;
  IsOwnedByProfile?: boolean | null;
};

type ValidationRuleRecord = {
  Id: string;
  ValidationName: string;
  Active?: boolean | null;
  EntityDefinition?: {
    QualifiedApiName?: string | null;
  };
};

let sdkPromise: Promise<DataSdk> | null = null;

function isSalesforceHost() {
  if (typeof window === 'undefined') {
    return false;
  }

  const hostname = window.location.hostname;
  return hostname.includes('force.com') || hostname.includes('salesforce.com');
}

async function getSdk() {
  if (!sdkPromise) {
    sdkPromise = createDataSDK().then((sdk) => sdk as DataSdk);
  }
  return sdkPromise;
}

async function fetchJson<T>(path: string): Promise<T> {
  const sdk = await getSdk();
  const response = await sdk.fetch(path);
  const payload = (await response.json()) as T & { message?: string };

  if (!response.ok) {
    throw new Error(payload.message ?? `Salesforce query failed for ${path}`);
  }

  return payload;
}

async function queryAll<T>(path: string) {
  const records: T[] = [];
  let nextPath: string | undefined = path;

  while (nextPath) {
    const payload: QueryResponse<T> = await fetchJson<QueryResponse<T>>(nextPath);
    records.push(...payload.records);
    nextPath = payload.nextRecordsUrl;
  }

  return records;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R[]>
) {
  const results: R[] = [];
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const output = await worker(items[currentIndex]);
      results.push(...output);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(runners);
  return results;
}

function encodeSoql(soql: string) {
  return encodeURIComponent(soql);
}

function toImportedAsset(partial: GovernanceImportedAsset) {
  return partial;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function preferFlowRecord(current: FlowRecord | undefined, candidate: FlowRecord) {
  if (!current) {
    return candidate;
  }

  const currentIsActive = current.Status === 'Active';
  const candidateIsActive = candidate.Status === 'Active';
  if (candidateIsActive && !currentIsActive) {
    return candidate;
  }
  if (
    candidateIsActive === currentIsActive &&
    (candidate.VersionNumber ?? 0) > (current.VersionNumber ?? 0)
  ) {
    return candidate;
  }

  return current;
}

function isCustomObjectApiName(apiName: string) {
  return (
    apiName.endsWith('__c') ||
    apiName.endsWith('__mdt') ||
    apiName.endsWith('__e') ||
    apiName.endsWith('__b') ||
    apiName.endsWith('__x')
  );
}

export async function discoverOrgMetadataAssets(): Promise<GovernanceImportedAsset[]> {
  if (!isSalesforceHost()) {
    return [];
  }

  const objectRecords = await queryAll<EntityDefinitionRecord>(
    `/services/data/v67.0/query?q=${encodeSoql(
      'SELECT QualifiedApiName, Label, DurableId FROM EntityDefinition WHERE IsCustomizable = true ORDER BY QualifiedApiName'
    )}`
  );

  const objectAssets = objectRecords
    .filter((record) => isCustomObjectApiName(record.QualifiedApiName))
    .map((record) =>
      toImportedAsset({
        externalKey: `object:${record.QualifiedApiName}`,
        name: record.Label || record.QualifiedApiName,
        apiName: record.QualifiedApiName,
        assetType: 'Object',
        department: 'Data Model',
        healthStatus: 'Healthy',
        healthScore: 92,
        riskLevel: 'Medium',
        sourceSystem: 'Salesforce Org Scan',
        stewardshipNotes: 'Imported from org object metadata.',
      })
    );

  const fieldAssets = await mapWithConcurrency(
    objectRecords.filter((record) => isCustomObjectApiName(record.QualifiedApiName)),
    4,
    async (record) => {
      const fieldRecords = await queryAll<FieldDefinitionRecord>(
        `/services/data/v67.0/query?q=${encodeSoql(
          `SELECT EntityDefinition.QualifiedApiName, QualifiedApiName, DurableId, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${record.QualifiedApiName}' ORDER BY QualifiedApiName`
        )}`
      );

      return fieldRecords
        .filter((fieldRecord) => fieldRecord.QualifiedApiName.endsWith('__c'))
        .map((fieldRecord) =>
          toImportedAsset({
            externalKey: `field:${fieldRecord.DurableId}`,
            name: `${record.Label || record.QualifiedApiName}.${fieldRecord.QualifiedApiName}`,
            apiName: fieldRecord.DurableId,
            assetType: 'Field',
            department: 'Data Model',
            healthStatus: 'Healthy',
            healthScore: 89,
            riskLevel: 'Medium',
            sourceSystem: 'Salesforce Org Scan',
            stewardshipNotes: `Imported from org field metadata. Type: ${fieldRecord.DataType ?? 'Unknown'}.`,
          })
        );
    }
  );

  const flowLabelRecords = await queryAll<FlowDefinitionViewRecord>(
    `/services/data/v67.0/query?q=${encodeSoql('SELECT ApiName, Label FROM FlowDefinitionView')}`
  );
  const flowLabels = new Map(
    flowLabelRecords.map((record) => [record.ApiName, record.Label || record.ApiName])
  );
  const flowVersionRecords = await queryAll<FlowRecord>(
    `/services/data/v67.0/tooling/query?q=${encodeSoql(
      'SELECT Definition.DeveloperName, ProcessType, Status, VersionNumber FROM Flow'
    )}`
  );

  const preferredFlows = new Map<string, FlowRecord>();
  flowVersionRecords.forEach((record) => {
    const apiName = record.Definition?.DeveloperName;
    if (!apiName) {
      return;
    }
    preferredFlows.set(apiName, preferFlowRecord(preferredFlows.get(apiName), record));
  });

  const flowAssets = [...preferredFlows.entries()].map(([apiName, record]) =>
    toImportedAsset({
      externalKey: `flow:${apiName}`,
      name: flowLabels.get(apiName) || apiName,
      apiName,
      assetType: 'Flow',
      department: 'Automation',
      healthStatus: record.Status === 'Active' ? 'Healthy' : 'NeedsReview',
      healthScore: record.Status === 'Active' ? 90 : 68,
      riskLevel: record.Status === 'Active' ? 'Medium' : 'High',
      sourceSystem: 'Salesforce Org Scan',
      stewardshipNotes: `Imported from org flow metadata. Status: ${record.Status ?? 'Unknown'}, version ${record.VersionNumber ?? 0}, type ${record.ProcessType ?? 'Unknown'}.`,
    })
  );

  const apexClassRecords = await queryAll<ApexClassRecord>(
    `/services/data/v67.0/tooling/query?q=${encodeSoql(
      'SELECT Name, ApiVersion, NamespacePrefix, Status FROM ApexClass ORDER BY Name'
    )}`
  );
  const apexAssets = apexClassRecords
    .filter((record) => !record.NamespacePrefix)
    .map((record) =>
      toImportedAsset({
        externalKey: `apex:${record.Name}`,
        name: record.Name,
        apiName: record.Name,
        assetType: 'ApexClass',
        department: 'Code',
        healthStatus: record.Status === 'Active' ? 'Healthy' : 'NeedsReview',
        healthScore: record.Status === 'Active' ? 88 : 70,
        riskLevel: 'Medium',
        sourceSystem: 'Salesforce Org Scan',
        stewardshipNotes: `Imported from org Apex metadata. Status: ${record.Status ?? 'Unknown'}, API version ${record.ApiVersion ?? 'Unknown'}.`,
      })
    );

  const permissionSetRecords = await queryAll<PermissionSetRecord>(
    `/services/data/v67.0/query?q=${encodeSoql(
      'SELECT Id, Name, Label, IsOwnedByProfile FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Name'
    )}`
  );
  const permissionSetAssets = permissionSetRecords.map((record) =>
    toImportedAsset({
      externalKey: `permissionset:${record.Name}`,
      name: record.Label || record.Name,
      apiName: record.Name,
      assetType: 'PermissionSet',
      department: 'Security',
      healthStatus: 'Healthy',
      healthScore: 91,
      riskLevel: 'Medium',
      sourceSystem: 'Salesforce Org Scan',
      stewardshipNotes: 'Imported from org permission set metadata.',
    })
  );

  const validationRuleRecords = await queryAll<ValidationRuleRecord>(
    `/services/data/v67.0/tooling/query?q=${encodeSoql(
      'SELECT ValidationName, EntityDefinition.QualifiedApiName, Active FROM ValidationRule ORDER BY ValidationName'
    )}`
  );
  const validationRuleAssets = validationRuleRecords.map((record) => {
    const entityApiName = record.EntityDefinition?.QualifiedApiName || 'UnknownObject';
    return toImportedAsset({
      externalKey: `validation:${entityApiName}.${record.ValidationName}`,
      name: `${entityApiName}.${record.ValidationName}`,
      apiName: `${entityApiName}.${record.ValidationName}`,
      assetType: 'ValidationRule',
      department: 'Data Model',
      healthStatus: record.Active ? 'Healthy' : 'NeedsReview',
      healthScore: record.Active ? 87 : 72,
      riskLevel: record.Active ? 'Medium' : 'High',
      sourceSystem: 'Salesforce Org Scan',
      stewardshipNotes: `Imported from org validation rule metadata. Active: ${record.Active ? 'Yes' : 'No'}.`,
    });
  });

  const dedupedAssets = new Map<string, GovernanceImportedAsset>();
  [
    ...objectAssets,
    ...fieldAssets,
    ...flowAssets,
    ...apexAssets,
    ...permissionSetAssets,
    ...validationRuleAssets,
  ].forEach((asset) => {
    dedupedAssets.set(asset.externalKey, {
      ...asset,
      lastAttestedOn: todayIsoDate(),
    });
  });

  return [...dedupedAssets.values()];
}
